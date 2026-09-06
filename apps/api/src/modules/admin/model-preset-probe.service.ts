import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { LlmChatModelFactory } from '../llm/providers/chat-model.factory';
import { toProviderName } from '../llm/llm-upstream-format';
import type {
  LlmPresetCapability,
  LlmUpstreamFormat,
  ResolvedLlmTextRequest,
} from '../llm/llm.types';

/** 探针单步超时；探测是交互式操作，不能让后台一直转圈 */
const PROBE_TIMEOUT_MS = 20_000;

/** 探测目标：一个尚未落库或已落库的预设连接参数。 */
export interface ModelPresetProbeTarget {
  presetId: string;
  upstreamFormat: LlmUpstreamFormat;
  platform: string;
  model: string;
  apiKey: string;
  baseURL?: string;
}

/** 探测结论。 */
export interface ModelPresetProbeResult {
  capability: LlmPresetCapability;
  /** 安全错误文本；成功时为 undefined */
  error?: string;
  /** 各级探针的明细，供后台展示"通到哪一步" */
  stages: {
    reachable: boolean;
    toolRoundTrip: boolean;
  };
}

/** 供应商连接的最小对话探测结论。 */
export interface ModelProviderReachabilityResult {
  reachable: boolean;
  error?: string;
}

/**
 * 模型预设连通性探针
 * @description 分两级：L1 验证 key / baseURL / 模型名可用，L2 验证工具往返能闭环。
 * 只做 L1 会给出误导性的绿灯——兼容网关与 Responses 格式恰恰是在工具回填那一步才炸
 * （见 docs/agent-loop-evolution.md 的 `fc_` call_id 事故），而 agent 链路全程依赖工具。
 * 因此「能否用于带工具的节点」必须由 L2 实测回答，不能由配置声明。
 */
@Injectable()
export class ModelPresetProbeService {
  private readonly logger = new Logger(ModelPresetProbeService.name);

  constructor(private readonly chatModelFactory: LlmChatModelFactory) {}

  /**
   * 对一组连接参数执行两级探测
   * @param target 待探测的连接参数（apiKey 为明文，仅在本次调用内使用）
   * @returns 返回能力档位与安全错误文本
   * @description L1 失败即返回 unreachable，不再尝试 L2：连不上时的工具探测只会得到同一个错误。
   * L1 通过但 L2 失败降级为 basic，该预设仍可用于 synthesize 这类无工具节点。
   */
  async probe(target: ModelPresetProbeTarget): Promise<ModelPresetProbeResult> {
    const reachable = await this.probeReachability(target);
    if (!reachable.reachable) {
      return {
        capability: 'unreachable',
        error: reachable.error,
        stages: { reachable: false, toolRoundTrip: false },
      };
    }

    const model = this.createModel(target);
    const toolRoundTrip = await this.runToolRoundTripProbe(
      model,
      target.apiKey,
    );
    if (!toolRoundTrip.ok) {
      return {
        capability: 'basic',
        error: toolRoundTrip.error,
        stages: { reachable: true, toolRoundTrip: false },
      };
    }

    return {
      capability: 'tools',
      stages: { reachable: true, toolRoundTrip: true },
    };
  }

  /**
   * 只执行连接级最小对话探测
   * @param target 连接及其下用于发起请求的模型参数
   * @returns 返回连接是否可达与安全错误文本
   * @description 连接级探测只证明 URL、密钥和选定模型可完成一次对话，不把结果冒充成
   * 该模型或同连接其他模型的工具能力结论。
   */
  async probeReachability(
    target: ModelPresetProbeTarget,
  ): Promise<ModelProviderReachabilityResult> {
    const result = await this.runReachabilityProbe(
      this.createModel(target),
      target.apiKey,
    );
    return result.ok
      ? { reachable: true }
      : { reachable: false, error: result.error };
  }

  /**
   * L1 连通性探针
   * @param model 已构造的聊天模型
   * @param apiKey 本次探测使用的密钥，用于清理异常文本中的意外回显
   * @returns 返回是否连通与安全错误文本
   * @description 只发一条最小消息，验证 apiKey、baseURL 与模型名拼写。
   */
  private async runReachabilityProbe(
    model: BaseChatModel,
    apiKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await model.invoke([new HumanMessage('ping')], {
        timeout: PROBE_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.toSafeErrorMessage(error, apiKey) };
    }
  }

  /**
   * L2 工具往返探针
   * @param model 已构造的聊天模型
   * @param apiKey 本次探测使用的密钥，用于清理异常文本中的意外回显
   * @returns 返回工具往返是否闭环与安全错误文本
   * @description 完整走一遍「模型发起 tool_call → 回灌 tool result → 模型正常收尾」。
   * 关键在第二次 invoke：工具调用 id 语义不匹配的上游正是在这一步返回 400，只发第一轮
   * 是发现不了的。模型选择不调用工具时判定为失败——无法证明闭环，就不能声称支持。
   */
  private async runToolRoundTripProbe(
    model: BaseChatModel,
    apiKey: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!model.bindTools) {
      return { ok: false, error: '当前模型客户端不支持工具绑定' };
    }
    const probeTool = tool(() => 'probe-ok', {
      name: 'connectivity_probe',
      description:
        '连通性探测专用工具。当用户要求调用探测工具时，必须调用它，不要直接回答。',
      schema: z.object({
        value: z.string().describe('原样回传的探测标记'),
      }),
    });

    try {
      const bound = model.bindTools([probeTool]);
      const first = (await bound.invoke(
        [
          new HumanMessage(
            '请调用 connectivity_probe 工具，参数 value 传 "ping"。只调用工具，不要直接回答。',
          ),
        ],
        { timeout: PROBE_TIMEOUT_MS },
      )) as AIMessage;

      const toolCall = first.tool_calls?.[0];
      if (!toolCall?.id) {
        return {
          ok: false,
          error: '上游未发起工具调用，无法验证工具往返是否闭环',
        };
      }

      // 回灌工具结果：id 语义不匹配的上游在此返回 400，这正是本探针存在的理由
      await bound.invoke(
        [
          new HumanMessage(
            '请调用 connectivity_probe 工具，参数 value 传 "ping"。只调用工具，不要直接回答。',
          ),
          first,
          new ToolMessage({
            content: 'probe-ok',
            tool_call_id: toolCall.id,
            name: toolCall.name,
          }),
        ],
        { timeout: PROBE_TIMEOUT_MS },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: this.toSafeErrorMessage(error, apiKey) };
    }
  }

  /**
   * 按目标参数构造探测用模型
   * @param target 待探测的连接参数
   * @returns 返回一次性使用的聊天模型
   * @description 复用生产链路的工厂而不是另写一份客户端构造：探针必须验证「真实调用会走的那条路」，
   * 另建一条路径会让探测通过而实际调用失败。
   */
  private createModel(target: ModelPresetProbeTarget): BaseChatModel {
    const request: ResolvedLlmTextRequest = {
      model: {
        id: target.presetId,
        provider: toProviderName(target.upstreamFormat),
        platform: target.platform,
        model: target.model,
        upstreamFormat: target.upstreamFormat,
        apiKey: target.apiKey,
        baseURL: target.baseURL,
      },
      generation: {},
    };
    return this.chatModelFactory.createChatModel(request);
  }

  /**
   * 转换可安全持久化与展示的错误说明
   * @param error 上游或 SDK 抛出的未知错误
   * @param apiKey 本次请求使用的密钥明文
   * @returns 返回受长度限制的错误文本
   * @description 错误文本会落库并展示在后台，必须假定它可能包含被回显的请求内容；
   * 这里只取 message，先移除可能被 SDK 或代理意外回显的密钥，再做长度限制。
   */
  private toSafeErrorMessage(error: unknown, apiKey: string): string {
    const rawMessage =
      error instanceof Error ? error.message : '未知的模型连通性错误';
    const message = apiKey
      ? rawMessage.split(apiKey).join('[REDACTED]')
      : rawMessage;
    this.logger.debug(`模型预设探测失败：${message.slice(0, 200)}`);
    return message.slice(0, 500);
  }
}
