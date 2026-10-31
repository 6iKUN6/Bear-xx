/** 默认工具组：无显式能力要求时可用的基础工具集合 */
export const DEFAULT_TOOL_GROUP = 'default';
/** 天气工具组：仅天气查询 */
export const WEATHER_TOOL_GROUP = 'weather';
/** 搜索工具组：仅联网搜索 */
export const SEARCH_TOOL_GROUP = 'search';
/** 生图工具组：AI 文生图（不入 default，按 agent 显式分配） */
export const IMAGE_TOOL_GROUP = 'image-gen';
/** 麦当劳点餐工具组：不入 default，只有绑定用户级凭据后才在请求内装配。 */
export const MCDONALDS_ORDER_TOOL_GROUP = 'mcd-order';
/** 渲染工具组：把 HTML 渲染成竖屏/横屏视频（不入 default，按 agent 显式分配）。 */
export const RENDER_TOOL_GROUP = 'render';

/**
 * 默认助手可在后台配置的工具组
 * @description 点餐依赖用户级凭据，按任务校验时没有凭据的用户会被整轮拒绝，不开放给默认助手。
 * 放在独立文件而不是注册表里：智能体模块要据此校验，但它不能依赖 AiModule（AiModule 反向依赖它）。
 */
export const AGENT_CONFIGURABLE_TOOL_GROUPS: readonly string[] = [
  DEFAULT_TOOL_GROUP,
  WEATHER_TOOL_GROUP,
  SEARCH_TOOL_GROUP,
  IMAGE_TOOL_GROUP,
];
