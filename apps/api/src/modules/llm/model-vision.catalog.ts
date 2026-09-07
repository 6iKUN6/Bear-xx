import type { LlmUpstreamFormat } from './llm.types';

export type LlmVisionTransport = 'public_url' | 'data_uri';

interface ModelVisionCapability {
  platform: string;
  upstreamFormat: LlmUpstreamFormat;
  model: string;
  transport: LlmVisionTransport;
}

/**
 * 已按供应商接口文档或实际接口确认的视觉模型闭集。
 * @description 视觉能力不能由管理员手工勾选；同名模型经不同协议或供应商网关时，
 * 图片传输约束可能不同，因此三元组缺一不可。
 */
const MODEL_VISION_CAPABILITIES: readonly ModelVisionCapability[] = [
  {
    platform: 'kimi',
    upstreamFormat: 'openai_chat_completions',
    model: 'kimi-k3',
    transport: 'data_uri',
  },
  {
    platform: 'kimi-coding',
    upstreamFormat: 'openai_chat_completions',
    model: 'k3',
    transport: 'data_uri',
  },
  {
    platform: 'kimi-coding',
    upstreamFormat: 'openai_chat_completions',
    model: 'k3-256k',
    transport: 'data_uri',
  },
  ...['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((model) => ({
    platform: 'openai',
    upstreamFormat: 'openai_responses' as const,
    model,
    transport: 'public_url' as const,
  })),
];

/** 按稳定模型身份读取图片传输能力；未命中表示当前不支持视觉输入。 */
export function findModelVisionTransport(
  platform: string,
  upstreamFormat: LlmUpstreamFormat,
  model: string,
): LlmVisionTransport | undefined {
  return MODEL_VISION_CAPABILITIES.find(
    (item) =>
      item.platform === platform &&
      item.upstreamFormat === upstreamFormat &&
      item.model === model,
  )?.transport;
}
