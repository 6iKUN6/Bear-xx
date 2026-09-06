import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import {
  ModelPresetCapability,
  type ModelPreset,
  type ModelProviderConnection,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { ReasoningSelection } from '@litter-bear/types';
import { LlmCredentialCryptoService } from './llm-credential-crypto.service';
import { toProviderName, toUpstreamFormat } from './llm-upstream-format';
import {
  findModelReasoningCapability,
  normalizeReasoningSelection,
  toReasoningCapabilityProjection,
  type NormalizeReasoningOptions,
} from './model-reasoning.catalog';
import type {
  LlmModelPreset,
  LlmModelPresetSummary,
  LlmModelSelector,
  LlmPresetCapability,
  LlmReasoningCapability,
  LlmTextRequest,
  ResolvedLlmTextRequest,
} from './llm.types';

/** Prisma 能力枚举 → 运行时能力档位。 */
const CAPABILITY_BY_DB_VALUE: Record<
  ModelPresetCapability,
  LlmPresetCapability
> = {
  [ModelPresetCapability.UNVERIFIED]: 'unverified',
  [ModelPresetCapability.UNREACHABLE]: 'unreachable',
  [ModelPresetCapability.BASIC]: 'basic',
  [ModelPresetCapability.TOOLS]: 'tools',
};

/** 内部生效预设：在 DB 行基础上带上密文，解密延后到真正调用模型时。 */
interface RegisteredModelPreset extends LlmModelPreset {
  name: string;
  connectionName: string;
  isDefault: boolean;
  apiKeyCiphertext: string | null;
  apiKeyFingerprint: string | null;
}

/**
 * 模型预设注册表
 * @description 后台数据库是模型配置的唯一来源。此前的「内置 < env 自动 < DB < LLM_MODEL_PRESETS」
 * 四层合并已全部移除：env 层优先级压在 DB 之上，会造成「后台改了却不生效」且毫无提示，
 * 在 apiKey 落库之后更会让一台机器上的残留 env 静默顶替线上配置。
 */
@Injectable()
export class LlmModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(LlmModelRegistryService.name);
  private modelPresets: RegisteredModelPreset[] = [];
  private loaded = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: LlmCredentialCryptoService,
  ) {}

  /** 启动时加载模型预设 */
  async onModuleInit(): Promise<void> {
    await this.invalidate();
  }

  /**
   * 重新从数据库加载模型预设
   * @returns 无返回值
   * @description 后台写操作后调用。数据库不可用时**直接抛错**，不再降级为静态预设：模型配置
   * 已是唯一源，静默降级会把一次数据库抖动变成「模型莫名换了一套配置」，排查代价极高。
   */
  async invalidate(): Promise<void> {
    const rows = await this.prisma.modelPreset.findMany({
      where: { enabled: true, connection: { enabled: true } },
      include: { connection: true },
      orderBy: [{ isDefault: 'desc' }, { presetId: 'asc' }],
    });
    this.modelPresets = rows.map((row) => this.toRegisteredPreset(row));
    this.loaded = true;
  }

  /**
   * 列出可安全下发前端的模型预设
   * @returns 返回不含 apiKey 的预设投影
   * @description 返回类型刻意没有 apiKey 字段：此前 listAvailableModels() 直接返回内部预设，
   * env 层预设带明文密钥，一旦被管理端复用就是直接泄露。对内解析走 resolveTextRequest。
   */
  listAvailableModels(): LlmModelPresetSummary[] {
    return this.requireLoadedPresets().map((preset) => ({
      id: preset.id,
      name: preset.name,
      connectionName: preset.connectionName,
      platform: preset.platform,
      model: preset.model,
      provider: preset.provider,
      upstreamFormat: preset.upstreamFormat ?? 'openai_chat_completions',
      baseURL: preset.baseURL,
      enabled: preset.enabled !== false,
      capability: preset.capability ?? 'unverified',
      apiKeyHint: preset.apiKeyFingerprint
        ? this.credentialCrypto.toDisplayHint(preset.apiKeyFingerprint)
        : undefined,
      temperature: preset.temperature,
      maxOutputTokens: preset.maxOutputTokens,
      topP: preset.topP,
      reasoningCapability: toReasoningCapabilityProjection(
        findModelReasoningCapability(
          preset.platform,
          preset.upstreamFormat ?? 'openai_chat_completions',
          preset.model,
        ),
      ),
    }));
  }

  /**
   * 解析文本生成请求
   * @param request 文本生成请求配置
   * @returns 返回已解析完成的模型与生成参数配置
   * @description 命中预设时在此解密 apiKey——明文只存在于本次调用的对象里，不写回缓存。
   * 解一个短串的 AES-GCM 开销可忽略，把明文挂在长生命周期缓存上才是真正的风险。
   */
  resolveTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): ResolvedLlmTextRequest {
    if (this.isResolvedTextRequest(request)) {
      return {
        ...request,
        reasoning: normalizeReasoningSelection(
          request.model.platform,
          request.model.upstreamFormat,
          request.model.model,
          request.reasoning,
          { applyDefault: false, generation: request.generation },
        ),
      };
    }

    const preset = this.resolvePreset(request?.model);
    if (!preset) {
      throw new BadRequestException('未匹配到任何模型预设，请先在后台配置模型');
    }

    const generation = {
      temperature: request?.generation?.temperature ?? preset.temperature,
      maxOutputTokens:
        request?.generation?.maxOutputTokens ?? preset.maxOutputTokens,
      topP: request?.generation?.topP ?? preset.topP,
    };

    return {
      model: {
        id: preset.id,
        provider: preset.provider,
        platform: preset.platform,
        model: preset.model,
        upstreamFormat: preset.upstreamFormat ?? 'openai_chat_completions',
        apiKey: this.decryptApiKey(preset),
        baseURL: preset.baseURL,
      },
      generation,
      reasoning: normalizeReasoningSelection(
        preset.platform,
        preset.upstreamFormat ?? 'openai_chat_completions',
        preset.model,
        request?.reasoning,
        { applyDefault: false, generation },
      ),
    };
  }

  /** 读取指定预设可安全下发前端的思考能力。 */
  getReasoningCapability(presetId: string): LlmReasoningCapability | undefined {
    const preset = this.requireLoadedPresets().find(
      (item) => item.id === presetId,
    );
    if (!preset) {
      return undefined;
    }
    return toReasoningCapabilityProjection(
      findModelReasoningCapability(
        preset.platform,
        preset.upstreamFormat ?? 'openai_chat_completions',
        preset.model,
      ),
    );
  }

  /** 按指定预设的精确能力目录规范化思考选择。 */
  normalizePresetReasoning(
    presetId: string,
    selection: ReasoningSelection | undefined,
    options: NormalizeReasoningOptions = {},
  ): ReasoningSelection | undefined {
    const preset = this.resolvePreset({ modelId: presetId });
    if (!preset) {
      throw new BadRequestException(`未找到模型预设: ${presetId}`);
    }
    const generation = {
      temperature: preset.temperature,
      maxOutputTokens: preset.maxOutputTokens,
      topP: preset.topP,
      ...options.generation,
    };
    return normalizeReasoningSelection(
      preset.platform,
      preset.upstreamFormat ?? 'openai_chat_completions',
      preset.model,
      selection,
      { ...options, generation },
    );
  }

  /**
   * 读取指定预设的能力档位
   * @param presetId 预设业务标识
   * @returns 返回能力档位；预设不存在时返回 undefined
   * @description 供 Flow 发布校验判断「这个预设能否配到带工具的节点上」。
   */
  getCapability(presetId: string): LlmPresetCapability | undefined {
    return this.requireLoadedPresets().find((item) => item.id === presetId)
      ?.capability;
  }

  /**
   * 将数据库行映射为内部生效预设
   * @param row ModelPreset 数据库行
   * @returns 返回带密文的内部预设
   * @description provider 由 upstreamFormat 单向推导，不再是独立字段：两处存同一事实必然漂移。
   */
  private toRegisteredPreset(
    row: ModelPreset & { connection: ModelProviderConnection },
  ): RegisteredModelPreset {
    const upstreamFormat = toUpstreamFormat(row.upstreamFormat);
    return {
      id: row.presetId,
      name: row.name,
      connectionName: row.connection.name,
      isDefault: row.isDefault,
      provider: toProviderName(upstreamFormat),
      upstreamFormat,
      platform: row.connection.providerKey,
      model: row.model,
      baseURL: row.connection.baseURL,
      temperature: row.temperature ?? undefined,
      maxOutputTokens: row.maxOutputTokens ?? undefined,
      topP: row.topP ?? undefined,
      enabled: row.enabled,
      capability: CAPABILITY_BY_DB_VALUE[row.capability],
      apiKeyCiphertext: row.connection.apiKeyCiphertext,
      apiKeyFingerprint: row.connection.apiKeyFingerprint,
    };
  }

  /**
   * 解密预设的 apiKey
   * @param preset 命中的内部预设
   * @returns 返回本次调用使用的 apiKey 明文
   * @description 未配置密钥时明确报错，而不是返回 undefined 让请求带空 key 打到上游——
   * 后者会得到一个来自上游的含糊 401，排查时看不出是本地漏配。
   */
  private decryptApiKey(preset: RegisteredModelPreset): string {
    if (!preset.apiKeyCiphertext) {
      throw new BadRequestException(
        `模型预设「${preset.id}」尚未配置 apiKey，请在后台补充`,
      );
    }
    return this.credentialCrypto.decrypt(preset.apiKeyCiphertext);
  }

  /**
   * 读取已加载的预设列表
   * @returns 返回当前生效预设
   * @description 未完成首次加载即被使用，说明启动顺序异常；此时返回空列表会被上层解释成
   * 「没有配置模型」，掩盖真正的问题，因此明确抛错。
   */
  private requireLoadedPresets(): RegisteredModelPreset[] {
    if (!this.loaded) {
      throw new ServiceUnavailableException('模型预设尚未加载完成');
    }
    return this.modelPresets;
  }

  /**
   * 解析模型预设
   * @param selector 模型选择条件
   * @returns 返回匹配到的模型预设；无选择条件时返回默认预设
   * @description 优先按 modelId 精确匹配，其次按 provider、platform、model 组合过滤；
   * 多条匹配且无法用默认预设消歧时拒绝，不做「取第一条」这种沉默猜测。
   */
  private resolvePreset(
    selector?: LlmModelSelector,
  ): RegisteredModelPreset | undefined {
    const models = this.requireLoadedPresets();

    if (selector?.modelId) {
      const preset = models.find((item) => item.id === selector.modelId);
      if (!preset) {
        throw new BadRequestException(`未找到模型预设: ${selector.modelId}`);
      }
      return preset;
    }

    const hasSelector = Boolean(
      selector?.provider || selector?.platform || selector?.model,
    );
    if (!hasSelector) {
      return this.getDefaultModelPreset();
    }

    const matched = models.filter((item) => {
      if (selector?.provider && item.provider !== selector.provider) {
        return false;
      }
      if (selector?.platform && item.platform !== selector.platform) {
        return false;
      }
      if (selector?.model && item.model !== selector.model) {
        return false;
      }
      return true;
    });

    if (matched.length === 1) {
      return matched[0];
    }
    if (matched.length > 1) {
      const defaultPreset = this.getDefaultModelPreset();
      const preferred = defaultPreset
        ? matched.find((item) => item.id === defaultPreset.id)
        : undefined;
      if (preferred) {
        return preferred;
      }
      throw new BadRequestException('模型选择不唯一，请补充 modelId 或 model');
    }
    return undefined;
  }

  /**
   * 获取默认模型预设
   * @returns 返回后台标记为默认的预设
   * @description 只认后台显式标记的 isDefault，不在默认模型停用或连接停用后退回列表第一项。
   * 第一版不做自动故障切换，静默换模型会改变能力、成本和供应商边界。
   */
  private getDefaultModelPreset(): RegisteredModelPreset | undefined {
    return this.requireLoadedPresets().find((preset) => preset.isDefault);
  }

  /**
   * 判断是否为已解析请求
   * @param request 文本生成请求配置
   * @returns 返回布尔值，true 表示已经完成解析
   * @description 通过检查请求中是否已包含解析后的模型 id、platform 与 provider 字段，识别是否需要再次解析。
   */
  private isResolvedTextRequest(
    request?: LlmTextRequest | ResolvedLlmTextRequest,
  ): request is ResolvedLlmTextRequest {
    const model = request?.model;
    if (!request || !model) {
      return false;
    }
    return 'id' in model && 'platform' in model && 'provider' in model;
  }
}
