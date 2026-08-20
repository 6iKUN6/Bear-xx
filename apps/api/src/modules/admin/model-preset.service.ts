import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModelPresetCapability, type ModelPreset } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmCredentialCryptoService } from '../llm/llm-credential-crypto.service';
import {
  ModelPresetProbeService,
  type ModelPresetProbeResult,
} from './model-preset-probe.service';
import { LlmModelRegistryService } from '../llm/llm-model-registry.service';
import {
  toDbUpstreamFormat,
  toProviderName,
  toUpstreamFormat,
} from '../llm/llm-upstream-format';
import type { LlmPresetCapability, LlmUpstreamFormat } from '../llm/llm.types';
import type {
  CreateModelPresetDto,
  ModelPresetProbeResultDto,
  ModelPresetResponseDto,
  ProbeModelPresetDto,
  UpdateModelPresetDto,
} from './dto/model-preset.dto';

/** 运行时能力档位 → Prisma 枚举。 */
const DB_CAPABILITY: Record<LlmPresetCapability, ModelPresetCapability> = {
  unverified: ModelPresetCapability.UNVERIFIED,
  unreachable: ModelPresetCapability.UNREACHABLE,
  basic: ModelPresetCapability.BASIC,
  tools: ModelPresetCapability.TOOLS,
};

/**
 * 模型预设 CRUD（管理端）
 * @description 后台是模型配置的唯一入口。apiKey 以 AES-256-GCM 密文落库，写入后永不回显，
 * 响应只带指纹尾部生成的脱敏 hint。写操作后失效 registry 缓存使配置即时生效。
 */
@Injectable()
export class ModelPresetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: LlmCredentialCryptoService,
    private readonly registry: LlmModelRegistryService,
    private readonly probeService: ModelPresetProbeService,
  ) {}

  async list(): Promise<ModelPresetResponseDto[]> {
    const rows = await this.prisma.modelPreset.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  async get(id: string): Promise<ModelPresetResponseDto> {
    const row = await this.prisma.modelPreset.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('模型预设不存在');
    }
    return this.toResponse(row);
  }

  async create(dto: CreateModelPresetDto): Promise<ModelPresetResponseDto> {
    const exists = await this.prisma.modelPreset.findUnique({
      where: { presetId: dto.presetId },
    });
    if (exists) {
      throw new BadRequestException(`预设 id 已存在：${dto.presetId}`);
    }
    const row = await this.prisma.modelPreset.create({
      data: {
        presetId: dto.presetId,
        name: dto.name,
        description: dto.description ?? '',
        upstreamFormat: toDbUpstreamFormat(
          this.requireUpstreamFormat(dto.upstreamFormat),
        ),
        platform: dto.platform,
        model: dto.model,
        baseURL: dto.baseURL ?? null,
        temperature: dto.temperature ?? null,
        maxOutputTokens: dto.maxOutputTokens ?? null,
        topP: dto.topP ?? null,
        enabled: dto.enabled ?? true,
        isDefault: dto.isDefault ?? false,
        ...this.toApiKeyWrite(dto.apiKey),
      },
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  async update(
    id: string,
    dto: UpdateModelPresetDto,
  ): Promise<ModelPresetResponseDto> {
    const current = await this.ensureExists(id);
    const apiKeyWrite = this.toApiKeyWrite(dto.apiKey);
    const format = dto.upstreamFormat
      ? this.requireUpstreamFormat(dto.upstreamFormat)
      : undefined;
    // 影响连通性的字段一旦变化，既有探测结论立即失效——继续显示上次的绿灯就是在骗人
    const connectionChanged =
      Object.keys(apiKeyWrite).length > 0 ||
      (format !== undefined &&
        toDbUpstreamFormat(format) !== current.upstreamFormat) ||
      (dto.baseURL !== undefined && dto.baseURL !== current.baseURL) ||
      (dto.model !== undefined && dto.model !== current.model);

    const row = await this.prisma.modelPreset.update({
      where: { id },
      data: {
        presetId: dto.presetId,
        name: dto.name,
        description: dto.description,
        ...(format ? { upstreamFormat: toDbUpstreamFormat(format) } : {}),
        platform: dto.platform,
        model: dto.model,
        baseURL: dto.baseURL,
        temperature: dto.temperature,
        maxOutputTokens: dto.maxOutputTokens,
        topP: dto.topP,
        enabled: dto.enabled,
        isDefault: dto.isDefault,
        ...apiKeyWrite,
        ...(connectionChanged
          ? {
              capability: ModelPresetCapability.UNVERIFIED,
              lastCheckedAt: null,
              lastCheckError: null,
            }
          : {}),
      },
    });
    await this.registry.invalidate();
    return this.toResponse(row);
  }

  /**
   * 对尚未保存的连接参数执行探测
   * @param dto 待探测的连接参数
   * @returns 返回探测结论
   * @description 支持保存前先测，避免把一个连不通的预设写进库。此路径不落库、不改任何预设的
   * capability——只有针对已存在预设的探测才写回结论。
   */
  async probeDraft(
    dto: ProbeModelPresetDto,
  ): Promise<ModelPresetProbeResultDto> {
    if (!dto.apiKey?.trim()) {
      throw new BadRequestException('探测未保存的预设时必须提供 apiKey');
    }
    const result = await this.probeService.probe({
      presetId: 'draft',
      upstreamFormat: this.requireUpstreamFormat(dto.upstreamFormat),
      platform: dto.platform,
      model: dto.model,
      apiKey: dto.apiKey.trim(),
      baseURL: dto.baseURL,
    });
    return this.toProbeResponse(result);
  }

  /**
   * 探测一个已保存的预设并写回结论
   * @param id 预设主键
   * @returns 返回探测结论
   * @description 使用已落库的密文密钥（解密后仅在本次调用内存在）。结论写回 capability 与
   * lastCheck* 字段，随后失效 registry 缓存，使 Flow 校验立即看到新的能力档位。
   */
  async probeExisting(id: string): Promise<ModelPresetProbeResultDto> {
    const row = await this.ensureExists(id);
    if (!row.apiKeyCiphertext) {
      throw new BadRequestException('该预设尚未配置 apiKey，无法探测');
    }
    const result = await this.probeService.probe({
      presetId: row.presetId,
      upstreamFormat: toUpstreamFormat(row.upstreamFormat),
      platform: row.platform,
      model: row.model,
      apiKey: this.credentialCrypto.decrypt(row.apiKeyCiphertext),
      baseURL: row.baseURL ?? undefined,
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
   * 将探测结论映射为响应体
   * @param result 探针结论
   * @returns 返回管理端响应
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

  async remove(id: string): Promise<void> {
    const row = await this.ensureExists(id);
    if (row.isDefault) {
      throw new BadRequestException('默认模型预设不可删除');
    }
    await this.prisma.modelPreset.delete({ where: { id } });
    await this.registry.invalidate();
  }

  /**
   * 构造 apiKey 的写入片段
   * @param apiKey 后台提交的 apiKey 明文；缺省表示不修改
   * @returns 返回可展开进 Prisma data 的字段片段；不修改时返回空对象
   * @description 返回空对象而非 undefined 字段，使「不传 apiKey」与「清空 apiKey」不会混淆：
   * 前者不产生任何写入，后者需要显式的删除接口，避免一次漏填就把线上密钥抹掉。
   */
  private toApiKeyWrite(
    apiKey: string | undefined,
  ):
    | { apiKeyCiphertext: string; apiKeyFingerprint: string }
    | Record<never, never> {
    const trimmed = apiKey?.trim();
    if (!trimmed) {
      return {};
    }
    return {
      apiKeyCiphertext: this.credentialCrypto.encrypt(trimmed),
      apiKeyFingerprint: this.credentialCrypto.fingerprint(trimmed),
    };
  }

  /**
   * 校验上游格式取值
   * @param value 外部提交的格式字符串
   * @returns 返回闭集内的格式
   * @description DTO 已用 IsIn 校验过，这里再收窄一次类型，避免依赖装饰器做类型保证。
   */
  private requireUpstreamFormat(value: string): LlmUpstreamFormat {
    if (
      value === 'openai_chat_completions' ||
      value === 'openai_responses' ||
      value === 'anthropic_messages'
    ) {
      return value;
    }
    throw new BadRequestException(`不支持的上游格式：${value}`);
  }

  private async ensureExists(id: string): Promise<ModelPreset> {
    const row = await this.prisma.modelPreset.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('模型预设不存在');
    }
    return row;
  }

  private toResponse(row: ModelPreset): ModelPresetResponseDto {
    const upstreamFormat = toUpstreamFormat(row.upstreamFormat);
    return {
      id: row.id,
      presetId: row.presetId,
      name: row.name,
      description: row.description,
      upstreamFormat,
      provider: toProviderName(upstreamFormat),
      platform: row.platform,
      model: row.model,
      baseURL: row.baseURL,
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      topP: row.topP,
      enabled: row.enabled,
      isDefault: row.isDefault,
      apiKeyConfigured: Boolean(row.apiKeyCiphertext),
      apiKeyHint: row.apiKeyFingerprint
        ? this.credentialCrypto.toDisplayHint(row.apiKeyFingerprint)
        : null,
      capability: row.capability.toLowerCase(),
      lastCheckedAt: row.lastCheckedAt?.getTime() ?? null,
      lastCheckError: row.lastCheckError,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }
}
