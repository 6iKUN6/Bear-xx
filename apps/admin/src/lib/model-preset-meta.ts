import type { BadgeProps } from "@/components/ui/badge";
import type { ModelPresetCapability, UpstreamFormat } from "@/api/types";

export interface UpstreamFormatMeta {
  value: UpstreamFormat;
  /** 由格式单向推导；后端不接受单独配 provider，前端也不提供该输入 */
  provider: "openai" | "anthropic";
  name: string;
  desc: string;
}

/**
 * 上游 wire 格式闭集的中文元数据。
 * 与后端 dto/model-preset.dto.ts 的 UPSTREAM_FORMATS 一一对应，新增格式时两边同步。
 */
export const UPSTREAM_FORMAT_OPTIONS: UpstreamFormatMeta[] = [
  {
    value: "openai_chat_completions",
    provider: "openai",
    name: "OpenAI Chat Completions",
    desc: "兼容面最广；DeepSeek / Kimi / 豆包 与绝大多数中转站都走这条",
  },
  {
    value: "openai_responses",
    provider: "openai",
    name: "OpenAI Responses（原生）",
    desc: "GPT-5 原生形态；部分中转站的工具调用 id 语义与之不一致，务必先测连接",
  },
  {
    value: "anthropic_messages",
    provider: "anthropic",
    name: "Anthropic Messages",
    desc: "Claude 原生形态，走 Anthropic SDK",
  },
];

const formatMetaByValue = new Map(
  UPSTREAM_FORMAT_OPTIONS.map((o) => [o.value, o]),
);

/** 上游格式中文名；未登记的取值回退原始串，不假装认识 */
export function upstreamFormatName(value: string): string {
  return formatMetaByValue.get(value as UpstreamFormat)?.name ?? value;
}

export function upstreamFormatMeta(
  value: UpstreamFormat,
): UpstreamFormatMeta | undefined {
  return formatMetaByValue.get(value);
}

export interface CapabilityMeta {
  name: string;
  desc: string;
  variant: BadgeProps["variant"];
}

/**
 * 能力档位的中文元数据。
 * 档位来自服务端探针实测，不是配置项——文案要说清「能用在哪」，因为发布校验按它拦截。
 */
export const CAPABILITY_META: Record<ModelPresetCapability, CapabilityMeta> = {
  unverified: {
    name: "未探测",
    desc: "还没测过连接，不能配到带工具的节点上",
    variant: "secondary",
  },
  unreachable: {
    name: "连不通",
    desc: "上次探测未能建立连接，此刻用它跑任务会直接失败",
    variant: "destructive",
  },
  basic: {
    name: "仅对话",
    desc: "能对话，但工具调用往返没跑通，只能用于不带工具的节点",
    variant: "warning",
  },
  tools: {
    name: "工具往返",
    desc: "已实测跑通工具调用与结果回灌，可用于任意节点",
    variant: "success",
  },
};

/** 能力档位展示信息；未知取值原样透出，避免把陌生档位误显示成绿灯 */
export function capabilityMeta(value: string): CapabilityMeta {
  return (
    CAPABILITY_META[value as ModelPresetCapability] ?? {
      name: value,
      desc: "未知的能力档位",
      variant: "outline",
    }
  );
}
