/**
 * 工具组 → 面向路由的中文能力描述
 * @description 群聊自动路由把成员能力喂给模型判断匹配度，直接给 `image-gen`
 * 这类技术标识语义太弱；这里译成动作化描述提升命中率。
 * 与移动端通讯录卡片的标签（apps/mobile/src/utils/agent.ts）用途不同：
 * 那边是短标签给人看，这边是给模型判断用的能力说明。
 * 未登记的组回退原名，避免新增工具组时静默丢失信息。
 */
const TOOL_GROUP_CAPABILITY_LABELS: Record<string, string> = {
  default: '通用对话',
  weather: '查询天气',
  search: '联网搜索实时信息',
  'image-gen': '画图 / 生成图片 / 修改图片',
};

/** 单个工具组的能力描述 */
export function toolGroupCapabilityLabel(group: string): string {
  return TOOL_GROUP_CAPABILITY_LABELS[group] ?? group;
}

/**
 * 工具组列表 → 能力描述串
 * @param groups 工具组名列表
 * @returns 返回顿号连接的中文能力描述；空列表回退「通用对话」
 */
export function describeToolGroups(groups: string[]): string {
  if (groups.length === 0) {
    return '通用对话';
  }
  return groups.map(toolGroupCapabilityLabel).join('、');
}
