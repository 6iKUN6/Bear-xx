import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ModelPresetCapability,
  ModelProviderConnectionStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmCredentialCryptoService } from '../llm/llm-credential-crypto.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  MODEL_PROVIDER_TEMPLATES,
  assertProviderAllowsUpstreamFormat,
  normalizeModelProviderBaseUrl,
  requireModelProviderTemplate,
} from '../llm/model-provider-template.catalog';
import {
  findModelReasoningCapability,
  toReasoningCapabilityProjection,
} from '../llm/model-reasoning.catalog';
import { toDbUpstreamFormat } from '../llm/llm-upstream-format';
import type { LlmUpstreamFormat } from '../llm/llm.types';
import type {
  CreateConnectionModelDto,
  CreateModelProviderConnectionDto,
  ModelProviderConnectionProbeResultDto,
  ModelProviderConnectionResponseDto,
  ModelProviderTemplateResponseDto,
  ProbeModelProviderConnectionDto,
  UpdateModelProviderConnectionDto,
} from './dto/model-preset.dto';
import { ModelPresetProbeService } from './model-preset-probe.service';
import {
  ModelPresetReferenceService,
  type ModelPresetReferencesById,
} from './model-preset-reference.service';
import { ModelPresetService } from './model-preset.service';

const CONNECTION_WITH_MODELS = {
  models: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ModelProviderConnectionInclude;

type ConnectionWithModels = Prisma.ModelProviderConnectionGetPayload<{
  include: typeof CONNECTION_WITH_MODELS;
}>;

/**
 * 模型供应商连接管理
 * @description 连接统一拥有供应商模板、baseURL 与加密密钥，其下模型只保存协议和模型级参数。
 */
@Injectable()
export class ModelProviderConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: LlmCredentialCryptoService,
    private readonly registry: LlmModelRegistryService,
    private readonly probeService: ModelPresetProbeService,
    private readonly referenceService: ModelPresetReferenceService,
    private readonly modelPresetService: ModelPresetService,
  ) {}

  /**
   * 列出代码内置供应商模板
   * @returns 返回不含凭据的模板安全投影
   * @description Admin 以该目录渲染供应商卡片并限制协议选项，后端创建时仍会再次校验。
   */
  listTemplates(): ModelProviderTemplateResponseDto[] {
    return MODEL_PROVIDER_TEMPLATES.map((template) => ({
      providerKey: template.providerKey,
      name: template.name,
      defaultBaseURL: template.defaultBaseURL,
      defaultUpstreamFormat: template.defaultUpstreamFormat,
      allowedUpstreamFormats: [...template.allowedUpstreamFormats],
      recommendedModels: template.recommendedModels.map((model) => ({
        ...model,
        reasoningCapability:
          toReasoningCapabilityProjection(
            findModelReasoningCapability(
              template.providerKey,
              model.upstreamFormat,
              model.model,
            ),
          ) ?? null,
      })),
    }));
  }

  /**
   * 列出供应商连接及其模型
   * @returns 返回按供应商和创建时间排序的连接安全投影
   * @description 批量查询所有模型引用，避免列表为每个连接或模型产生 N+1 查询。
   */
  async list(): Promise<ModelProviderConnectionResponseDto[]> {
    const rows = await this.prisma.modelProviderConnection.findMany({
      include: CONNECTION_WITH_MODELS,
      orderBy: [{ providerKey: 'asc' }, { createdAt: 'asc' }],
    });
    const references = await this.referenceService.findByPresetIds(
      rows.flatMap((row) => row.models.map((model) => model.presetId)),
    );
    return rows.map((row) => this.toResponse(row, references));
  }

  /**
   * 查询单个供应商连接
   * @param id 连接数据库 ID
   * @returns 返回连接、模型及聚合引用数量
   * @description 连接不存在时明确返回 404，不伪装成空详情。
   */
  async get(id: string): Promise<ModelProviderConnectionResponseDto> {
    const row = await this.ensureExists(id);
    const references = await this.referenceService.findByPresetIds(
      row.models.map((model) => model.presetId),
    );
    return this.toResponse(row, references);
  }

  /**
   * 创建供应商连接及首批模型
   * @param dto 供应商模板、共享连接字段与至少一个模型
   * @returns 返回已创建连接的完整安全投影
   * @description 连接和初始模型在同一事务写入；任一模型或协议无效时不留下半个连接。
   */
  async create(
    dto: CreateModelProviderConnectionDto,
  ): Promise<ModelProviderConnectionResponseDto> {
    requireModelProviderTemplate(dto.providerKey);
    const baseURL = normalizeModelProviderBaseUrl(dto.baseURL);
    const apiKey = dto.apiKey.trim();
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('连接名称不能为空');
    }
    if (!apiKey) {
      throw new BadRequestException('新建供应商连接必须提供 API Key');
    }
    this.validateInitialModels(dto.providerKey, dto.models, dto.enabled);
    const connectionKey = this.createConnectionKey(dto.providerKey);
    const apiKeyWrite = {
      apiKeyCiphertext: this.credentialCrypto.encrypt(apiKey),
      apiKeyFingerprint: this.credentialCrypto.fingerprint(apiKey),
    };

    const created = await this.prisma.$transaction(async (transaction) => {
      if (dto.models.some((model) => model.isDefault)) {
        await transaction.modelPreset.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }
      return transaction.modelProviderConnection.create({
        data: {
          connectionKey,
          providerKey: dto.providerKey,
          name,
          baseURL,
          enabled: dto.enabled ?? true,
          ...apiKeyWrite,
          models: {
            create: dto.models.map((model) =>
              this.toInitialModelCreate(connectionKey, model),
            ),
          },
        },
        select: { id: true },
      });
    });
    await this.registry.invalidate();
    return this.get(created.id);
  }

  /**
   * 更新供应商连接
   * @param id 连接数据库 ID
   * @param dto 可变的显示名、根地址、密钥和启用状态
   * @returns 返回更新后的连接安全投影
   * @description URL、密钥或重新启用会在同一事务把连接和全部子模型重置为未探测。
   */
  async update(
    id: string,
    dto: UpdateModelProviderConnectionDto,
  ): Promise<ModelProviderConnectionResponseDto> {
    const current = await this.ensureExists(id);
    const baseURL =
      dto.baseURL === undefined
        ? current.baseURL
        : normalizeModelProviderBaseUrl(dto.baseURL);
    const apiKey = dto.apiKey?.trim();
    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) {
      throw new BadRequestException('连接名称不能为空');
    }
    if (dto.apiKey !== undefined && !apiKey) {
      throw new BadRequestException('API Key 不能为空');
    }
    const connectionChanged =
      baseURL !== current.baseURL ||
      apiKey !== undefined ||
      (dto.enabled === true && !current.enabled);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.modelProviderConnection.update({
        where: { id },
        data: {
          name,
          baseURL: dto.baseURL === undefined ? undefined : baseURL,
          enabled: dto.enabled,
          ...(apiKey
            ? {
                apiKeyCiphertext: this.credentialCrypto.encrypt(apiKey),
                apiKeyFingerprint: this.credentialCrypto.fingerprint(apiKey),
              }
            : {}),
          ...(connectionChanged
            ? {
                status: ModelProviderConnectionStatus.UNVERIFIED,
                lastCheckedAt: null,
                lastCheckError: null,
              }
            : {}),
        },
      });
      if (connectionChanged) {
        await transaction.modelPreset.updateMany({
          where: { connectionId: id },
          data: {
            capability: ModelPresetCapability.UNVERIFIED,
            lastCheckedAt: null,
            lastCheckError: null,
          },
        });
      }
    });
    await this.registry.invalidate();
    return this.get(id);
  }

  /**
   * 使用连接下指定模型执行最小连通性探测
   * @param id 连接数据库 ID
   * @param dto 指定用于测试的模型预设
   * @returns 返回连接可达状态和安全错误摘要
   * @description 只更新连接状态，不把一次最小对话冒充成模型工具能力结论。
   */
  async probe(
    id: string,
    dto: ProbeModelProviderConnectionDto,
  ): Promise<ModelProviderConnectionProbeResultDto> {
    const connection = await this.ensureExists(id);
    if (!connection.enabled) {
      throw new BadRequestException('供应商连接已停用，无法测试');
    }
    const model = connection.models.find(
      (item) => item.id === dto.modelPresetId,
    );
    if (!model) {
      throw new BadRequestException('测试模型不属于当前供应商连接');
    }
    if (!model.enabled) {
      throw new BadRequestException('测试模型已停用');
    }
    const result = await this.probeService.probeReachability({
      presetId: model.presetId,
      upstreamFormat: this.requireUpstreamFormat(model.upstreamFormat),
      platform: connection.providerKey,
      model: model.model,
      apiKey: this.credentialCrypto.decrypt(connection.apiKeyCiphertext),
      baseURL: connection.baseURL,
    });
    const status = result.reachable
      ? ModelProviderConnectionStatus.REACHABLE
      : ModelProviderConnectionStatus.UNREACHABLE;
    await this.prisma.modelProviderConnection.update({
      where: { id },
      data: {
        status,
        lastCheckedAt: new Date(),
        lastCheckError: result.error ?? null,
      },
    });
    return {
      status: status.toLowerCase(),
      reachable: result.reachable,
      error: result.error ?? null,
    };
  }

  /**
   * 删除空供应商连接
   * @param id 连接数据库 ID
   * @returns 无返回值
   * @description 连接下仍有模型时拒绝删除，不级联移除可能被 Agent 或 Flow 引用的模型。
   */
  async remove(id: string): Promise<void> {
    const connection = await this.ensureExists(id);
    if (connection.models.length > 0) {
      throw new BadRequestException(
        `供应商连接下仍有 ${connection.models.length} 个模型，请先处理模型引用并删除模型`,
      );
    }
    await this.prisma.modelProviderConnection.delete({ where: { id } });
    await this.registry.invalidate();
  }

  /**
   * 校验创建连接时的模型集合
   * @param providerKey 供应商模板标识
   * @param models 至少一个初始模型
   * @param connectionEnabled 连接启用状态
   * @returns 无返回值，重复模型或非法协议时抛出参数错误
   * @description 同一连接的模型 ID 必须唯一，且最多只能声明一个系统默认模型。
   */
  private validateInitialModels(
    providerKey: string,
    models: readonly CreateConnectionModelDto[],
    connectionEnabled: boolean | undefined,
  ): void {
    const modelIds = models.map((model) => model.model.trim());
    if (models.some((model) => !model.name.trim())) {
      throw new BadRequestException('模型名称不能为空');
    }
    if (modelIds.some((model) => !model)) {
      throw new BadRequestException('模型 ID 不能为空');
    }
    if (new Set(modelIds).size !== modelIds.length) {
      throw new BadRequestException('同一供应商连接不能重复添加相同模型 ID');
    }
    if (models.filter((model) => model.isDefault).length > 1) {
      throw new BadRequestException('一次只能设置一个系统默认模型');
    }
    if (
      connectionEnabled === false &&
      models.some((model) => model.isDefault)
    ) {
      throw new BadRequestException('停用的供应商连接不能包含系统默认模型');
    }
    if (models.some((model) => model.enabled === false && model.isDefault)) {
      throw new BadRequestException('停用的模型不能设为系统默认模型');
    }
    for (const model of models) {
      assertProviderAllowsUpstreamFormat(
        providerKey,
        this.requireUpstreamFormat(model.upstreamFormat),
      );
    }
  }

  /**
   * 构造嵌套模型创建数据
   * @param connectionKey 稳定连接业务键
   * @param dto 初始模型字段
   * @returns 返回 Prisma 嵌套创建数据
   * @description presetId 只在创建时生成，后续修改模型 ID 不会改变它。
   */
  private toInitialModelCreate(
    connectionKey: string,
    dto: CreateConnectionModelDto,
  ): Prisma.ModelPresetCreateWithoutConnectionInput {
    const model = dto.model.trim();
    const presetId = `${connectionKey}:${model}`;
    if (presetId.length > 400) {
      throw new BadRequestException('自动生成的模型预设 ID 过长');
    }
    return {
      presetId,
      name: dto.name.trim(),
      description: dto.description?.trim() ?? '',
      model,
      upstreamFormat: toDbUpstreamFormat(
        this.requireUpstreamFormat(dto.upstreamFormat),
      ),
      temperature: dto.temperature ?? null,
      maxOutputTokens: dto.maxOutputTokens ?? null,
      topP: dto.topP ?? null,
      enabled: dto.enabled ?? true,
      isDefault: dto.isDefault ?? false,
    };
  }

  /**
   * 创建不可变连接业务键
   * @param providerKey 供应商模板标识
   * @returns 返回供应商前缀与随机段组成的稳定键
   * @description 随机段避免同一供应商的多份连接在重命名或删除重建时发生 ID 冲突。
   */
  private createConnectionKey(providerKey: string): string {
    return `${providerKey}-${randomBytes(8).toString('hex')}`;
  }

  /**
   * 校验并收窄 Prisma 上游协议枚举
   * @param value Prisma 枚举或 DTO 字符串
   * @returns 返回运行时上游协议闭集成员
   * @description Prisma 枚举与 API 字符串在此统一转换，避免服务内散落大小写判断。
   */
  private requireUpstreamFormat(value: string): LlmUpstreamFormat {
    const normalized = value.toLowerCase();
    if (
      normalized === 'openai_chat_completions' ||
      normalized === 'openai_responses' ||
      normalized === 'anthropic_messages' ||
      normalized === 'gemini_generate_content'
    ) {
      return normalized;
    }
    throw new BadRequestException(`不支持的上游格式：${value}`);
  }

  /**
   * 确认连接存在并加载全部模型
   * @param id 供应商连接数据库 ID
   * @returns 返回连接及按默认和创建时间排序的模型
   * @description 供详情、更新、探测和删除复用一致的不存在错误。
   */
  private async ensureExists(id: string): Promise<ConnectionWithModels> {
    const row = await this.prisma.modelProviderConnection.findUnique({
      where: { id },
      include: CONNECTION_WITH_MODELS,
    });
    if (!row) {
      throw new NotFoundException('模型供应商连接不存在');
    }
    return row;
  }

  /**
   * 映射连接、模型和引用数量
   * @param row 已加载全部模型的供应商连接
   * @param references 以 presetId 为键的批量引用结果
   * @returns 返回不含密钥密文的管理端连接 DTO
   * @description Flow 数量按逻辑 Flow 去重，避免同一 Flow 多版本或多个模型重复计数。
   */
  private toResponse(
    row: ConnectionWithModels,
    references: ModelPresetReferencesById,
  ): ModelProviderConnectionResponseDto {
    const { models, ...connection } = row;
    const agentIds = new Set<string>();
    const flowIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const model of models) {
      for (const item of references.get(model.presetId)?.items ?? []) {
        if (item.type === 'agent') agentIds.add(item.id);
        if (item.type === 'flow') flowIds.add(item.id);
        if (item.type === 'task') taskIds.add(item.id);
      }
    }
    return {
      id: row.id,
      connectionKey: row.connectionKey,
      providerKey: row.providerKey,
      name: row.name,
      baseURL: row.baseURL,
      enabled: row.enabled,
      apiKeyConfigured: Boolean(row.apiKeyCiphertext),
      apiKeyHint: this.credentialCrypto.toDisplayHint(row.apiKeyFingerprint),
      status: row.status.toLowerCase(),
      lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
      lastCheckError: row.lastCheckError,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      models: models.map((model) =>
        this.modelPresetService.toResponse({ ...model, connection }),
      ),
      agentReferenceCount: agentIds.size,
      flowReferenceCount: flowIds.size,
      taskReferenceCount: taskIds.size,
    };
  }
}
