import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModelPresetCapability, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmCredentialCryptoService } from '../llm/llm-credential-crypto.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import { assertProviderAllowsUpstreamFormat } from '../llm/model-provider-template.catalog';
import {
  findModelReasoningCapability,
  toReasoningCapabilityProjection,
} from '../llm/model-reasoning.catalog';
import {
  toDbUpstreamFormat,
  toProviderName,
  toUpstreamFormat,
} from '../llm/llm-upstream-format';
import type { LlmPresetCapability, LlmUpstreamFormat } from '../llm/llm.types';
import type {
  CreateModelPresetDto,
  ModelPresetProbeResultDto,
  ModelPresetReferencesResponseDto,
  ModelPresetResponseDto,
  UpdateModelPresetDto,
} from './dto/model-preset.dto';
import {
  ModelPresetProbeService,
  type ModelPresetProbeResult,
} from './model-preset-probe.service';
import { ModelPresetReferenceService } from './model-preset-reference.service';

/** 运行时能力档位到 Prisma 枚举的映射。 */
const DB_CAPABILITY: Record<LlmPresetCapability, ModelPresetCapability> = {
  unverified: ModelPresetCapability.UNVERIFIED,
  unreachable: ModelPresetCapability.UNREACHABLE,
  basic: ModelPresetCapability.BASIC,
  tools: ModelPresetCapability.TOOLS,
};

const MODEL_PRESET_WITH_CONNECTION = {
  connection: true,
} satisfies Prisma.ModelPresetInclude;

export type ModelPresetWithConnection = Prisma.ModelPresetGetPayload<{
  include: typeof MODEL_PRESET_WITH_CONNECTION;
}>;

/**
 * 模型预设 CRUD（管理端）
 * @description 模型只保存模型级协议和生成参数；URL 与密钥统一取自所属供应商连接。探测结果
 * 决定模型能否进入带工具 Flow，presetId 创建后保持不变。
 */
@Injectable()
export class ModelPresetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: LlmCredentialCryptoService,
    private readonly registry: LlmModelRegistryService,
    private readonly probeService: ModelPresetProbeService,
    private readonly referenceService: ModelPresetReferenceService,
  ) {}

  /**
   * 列出全部模型预设
   * @returns 返回包含所属连接安全摘要的模型预设列表
   * @description 供管理端和连接页面读取，不下发连接密钥密文。
   */
  async list(): Promise<ModelPresetResponseDto[]> {
    const rows = await this.prisma.modelPreset.findMany({
      include: MODEL_PRESET_WITH_CONNECTION,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  /**
   * 查询模型预设详情
   * @param id 模型预设数据库 ID
   * @returns 返回模型和所属连接安全摘要
   * @description 不通过 presetId 猜测归属连接，始终读取数据库关系。
   */
  async get(id: string): Promise<ModelPresetResponseDto> {
    return this.toResponse(await this.ensureExists(id));
  }

  /**
   * 在指定连接下创建模型预设
   * @param connectionId 供应商连接数据库 ID
   * @param dto 模型名称、上游协议和生成参数
   * @returns 返回创建后的模型预设
   * @description presetId 由不可变 connectionKey 与创建时模型 ID 生成；同一连接不允许重复模型 ID。
   */
  async create(
    connectionId: string,
    dto: CreateModelPresetDto,
  ): Promise<ModelPresetResponseDto> {
    const connection = await this.prisma.modelProviderConnection.findUnique({
      where: { id: connectionId },
    });
    if (!connection) {
      throw new NotFoundException('模型供应商连接不存在');
    }
    const upstreamFormat = this.requireUpstreamFormat(dto.upstreamFormat);
    assertProviderAllowsUpstreamFormat(connection.providerKey, upstreamFormat);
    const name = dto.name.trim();
    const model = dto.model.trim();
    if (!name || !model) {
      throw new BadRequestException('模型名称和模型 ID 不能为空');
    }
    if (
      dto.isDefault &&
      (dto.enabled === false || connection.enabled === false)
    ) {
      throw new BadRequestException('停用的模型或连接不能设为系统默认模型');
    }
    const presetId = `${connection.connectionKey}:${model}`;
    if (presetId.length > 400) {
      throw new BadRequestException('自动生成的模型预设 ID 过长');
    }

    const row = await this.prisma.$transaction(async (transaction) => {
      if (dto.isDefault) {
        await transaction.modelPreset.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return transaction.modelPreset.create({
        data: {
          connectionId,
          presetId,
          name,
          description: dto.description?.trim() ?? '',
          model,
          upstreamFormat: toDbUpstreamFormat(upstreamFormat),
          temperature: dto.temperature ?? null,
          maxOutputTokens: dto.maxOutputTokens ?? null,
          topP: dto.topP ?? null,
          enabled: dto.enabled ?? true,
          isDefault: dto.isDefault ?? false,
        },
        include: MODEL_PRESET_WITH_CONNECTION,
      });
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  /**
   * 更新模型预设
   * @param id 模型预设数据库 ID
   * @param dto 可修改的模型字段
   * @returns 返回更新后的模型预设
   * @description 修改模型 ID 或上游协议时只重置当前模型能力；presetId 与 connectionId 不变。
   */
  async update(
    id: string,
    dto: UpdateModelPresetDto,
  ): Promise<ModelPresetResponseDto> {
    const current = await this.ensureExists(id);
    const upstreamFormat = dto.upstreamFormat
      ? this.requireUpstreamFormat(dto.upstreamFormat)
      : toUpstreamFormat(current.upstreamFormat);
    assertProviderAllowsUpstreamFormat(
      current.connection.providerKey,
      upstreamFormat,
    );
    const name = dto.name?.trim();
    const model = dto.model?.trim();
    if (dto.name !== undefined && !name) {
      throw new BadRequestException('模型名称不能为空');
    }
    if (dto.model !== undefined && !model) {
      throw new BadRequestException('模型 ID 不能为空');
    }
    if (
      dto.isDefault === true &&
      current.isDefault === false &&
      (dto.enabled === false || current.connection.enabled === false)
    ) {
      throw new BadRequestException('停用的模型或连接不能设为系统默认模型');
    }
    const connectionChanged =
      (model !== undefined && model !== current.model) ||
      toDbUpstreamFormat(upstreamFormat) !== current.upstreamFormat;

    const row = await this.prisma.$transaction(async (transaction) => {
      if (dto.isDefault) {
        await transaction.modelPreset.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return transaction.modelPreset.update({
        where: { id },
        data: {
          name,
          description: dto.description?.trim(),
          model,
          upstreamFormat: dto.upstreamFormat
            ? toDbUpstreamFormat(upstreamFormat)
            : undefined,
          temperature: dto.temperature,
          maxOutputTokens: dto.maxOutputTokens,
          topP: dto.topP,
          enabled: dto.enabled,
          isDefault: dto.isDefault,
          ...(connectionChanged
            ? {
                capability: ModelPresetCapability.UNVERIFIED,
                lastCheckedAt: null,
                lastCheckError: null,
              }
            : {}),
        },
        include: MODEL_PRESET_WITH_CONNECTION,
      });
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  /**
   * 使用所属连接探测模型完整能力并写回结论
   * @param id 模型预设数据库 ID
   * @returns 返回基础连通性和工具往返结论
   * @description 连接或模型停用时拒绝探测；密钥仅在本次调用内解密。
   */
  async probeExisting(id: string): Promise<ModelPresetProbeResultDto> {
    const row = await this.ensureExists(id);
    if (!row.connection.enabled) {
      throw new BadRequestException('所属供应商连接已停用，无法探测');
    }
    if (!row.enabled) {
      throw new BadRequestException('模型预设已停用，无法探测');
    }
    const result = await this.probeService.probe({
      presetId: row.presetId,
      upstreamFormat: toUpstreamFormat(row.upstreamFormat),
      platform: row.connection.providerKey,
      model: row.model,
      apiKey: this.credentialCrypto.decrypt(row.connection.apiKeyCiphertext),
      baseURL: row.connection.baseURL,
    });
    await this.prisma.modelPreset.update({
      where: { id },
      data: {
        capability: DB_CAPABILITY[result.capability],
        lastCheckedAt: new Date(),
        lastCheckError: result.error ?? null,
      },
    });
    await this.registry.invalidate();
    return this.toProbeResponse(result);
  }

  /**
   * 查询模型预设引用位置
   * @param id 模型预设数据库 ID
   * @returns 返回 Agent 和 Flow 引用汇总
   * @description 先确认模型存在，再以稳定 presetId 查询引用，避免把未知 ID 显示成零引用。
   */
  async references(id: string): Promise<ModelPresetReferencesResponseDto> {
    const row = await this.ensureExists(id);
    return this.referenceService.findByPresetId(row.presetId);
  }

  /**
   * 删除未被引用且非默认的模型预设
   * @param id 模型预设数据库 ID
   * @returns 无返回值
   * @description 删除前返回结构化引用位置，不依赖数据库约束生成含糊错误。
   */
  async remove(id: string): Promise<void> {
    const row = await this.ensureExists(id);
    if (row.isDefault) {
      throw new BadRequestException('系统默认模型预设不可删除');
    }
    const references = await this.referenceService.findByPresetId(row.presetId);
    if (references.items.length > 0) {
      throw new BadRequestException({
        message: '模型预设仍被 Agent 或 Flow 引用，不能删除',
        references,
      });
    }
    await this.prisma.modelPreset.delete({ where: { id } });
    await this.registry.invalidate();
  }

  /**
   * 将数据库模型和连接映射为管理端安全投影
   * @param row 已联表加载所属连接的模型预设
   * @returns 返回不含密钥密文的模型预设 DTO
   * @description 该映射供连接列表与模型详情复用，API Key 只显示不可逆指纹生成的 hint。
   */
  toResponse(row: ModelPresetWithConnection): ModelPresetResponseDto {
    const upstreamFormat = toUpstreamFormat(row.upstreamFormat);
    return {
      id: row.id,
      presetId: row.presetId,
      name: row.name,
      description: row.description,
      upstreamFormat,
      provider: toProviderName(upstreamFormat),
      model: row.model,
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      topP: row.topP,
      reasoningCapability:
        toReasoningCapabilityProjection(
          findModelReasoningCapability(
            row.connection.providerKey,
            upstreamFormat,
            row.model,
          ),
        ) ?? null,
      enabled: row.enabled,
      isDefault: row.isDefault,
      apiKeyConfigured: Boolean(row.connection.apiKeyCiphertext),
      apiKeyHint: this.credentialCrypto.toDisplayHint(
        row.connection.apiKeyFingerprint,
      ),
      capability: row.capability.toLowerCase(),
      lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
      lastCheckError: row.lastCheckError,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      connection: {
        id: row.connection.id,
        connectionKey: row.connection.connectionKey,
        providerKey: row.connection.providerKey,
        name: row.connection.name,
        baseURL: row.connection.baseURL,
        enabled: row.connection.enabled,
        status: row.connection.status.toLowerCase(),
      },
    };
  }

  /**
   * 校验并收窄上游协议
   * @param value DTO 中的上游协议字符串
   * @returns 返回运行时上游协议闭集成员
   * @description DTO 装饰器负责请求校验，此处继续做类型收窄，避免把任意字符串传入运行时。
   */
  private requireUpstreamFormat(value: string): LlmUpstreamFormat {
    if (
      value === 'openai_chat_completions' ||
      value === 'openai_responses' ||
      value === 'anthropic_messages' ||
      value === 'gemini_generate_content'
    ) {
      return value;
    }
    throw new BadRequestException(`不支持的上游格式：${value}`);
  }

  /**
   * 确认模型存在并加载所属连接
   * @param id 模型预设数据库 ID
   * @returns 返回联表模型记录
   * @description 所有详情、更新、探测和删除入口共用，确保错误口径一致。
   */
  private async ensureExists(id: string): Promise<ModelPresetWithConnection> {
    const row = await this.prisma.modelPreset.findUnique({
      where: { id },
      include: MODEL_PRESET_WITH_CONNECTION,
    });
    if (!row) {
      throw new NotFoundException('模型预设不存在');
    }
    return row;
  }

  /**
   * 映射模型探测结论
   * @param result 内部完整探测结果
   * @returns 返回管理端安全 DTO
   * @description 不透传上游响应，只返回经过截断和清理的错误摘要。
   */
  private toProbeResponse(
    result: ModelPresetProbeResult,
  ): ModelPresetProbeResultDto {
    return {
      capability: result.capability,
      reachable: result.stages.reachable,
      toolRoundTrip: result.stages.toolRoundTrip,
      error: result.error ?? null,
    };
  }
}
