import { View } from "@tarojs/components";

/**
 * 统一线条风 SVG 图标
 * @description 小程序不支持内联 SVG 元素，这里把闭集图标编成 data-URI，
 * 以 mask-image 敷在 `background-color: currentColor` 上——颜色跟随文本色，
 * 天然消费 --lb-* token，无需逐图标传色值。path 与 UI-Preview/mobile-redesign-v2
 * 的 symbol 集同源（描边 1.7、round 端点）。
 */

const ICON_PATHS = {
  // 方向
  back: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronDown: '<path d="M5 9l7 7 7-7"/>',
  // 基础动作
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  plusCircle:
    '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle:
    '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  alertCircle:
    '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16.25h.01"/>',
  stop: '<rect x="8" y="8" width="8" height="8" rx="1.5" fill="black" stroke="none"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  // 交流
  send: '<path d="M12 19V6M6 11l6-6 6 6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  chat: '<path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5 4z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
  group:
    '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c1-3.4 3.4-4.8 6.2-4.8s5.2 1.4 6.2 4.8"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 15.4c2.6.2 4.6 1.5 5.5 4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/>',
  // 对象与语义
  sparkles:
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  zap: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  edit: '<path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h6M9 16h6M9 8h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  broom: '<path d="M14 4l6 6M4 20c2-6 5-9 9-10l1 1c-1 4-4 7-10 9z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  palette:
    '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-.8 2-1.8 0-1-.7-1.5-.7-2.4 0-1 .8-1.8 2-1.8H17a4.5 4.5 0 0 0 4.5-4.5C21.5 6.3 17.3 3 12 3z"/><circle cx="7.5" cy="11" r="1.1"/><circle cx="12" cy="7.5" r="1.1"/><circle cx="16.5" cy="11" r="1.1"/>',
  order:
    '<path d="M6 3h12v18l-2-1.4L14 21l-2-1.4L10 21l-2-1.4L6 21z"/><path d="M9 8h6M9 12h6"/>',
  shoppingBag:
    '<path d="M6 8h12l-1 12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 8z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  link: '<path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1l-1.2 1.2M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1l1.2-1.2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  login:
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
} as const;

export type AppIconName = keyof typeof ICON_PATHS;

/** 完整 style 串按图标名缓存，避免每次渲染重编码 */
const styleCache = new Map<AppIconName, string>();

/**
 * 组装图标的内联 style 字符串
 * @description 必须用字符串而非对象：Taro 的 Style 白名单只认不带前缀的 mask*，
 * 对象写法里的 WebkitMaskImage 会被静默丢弃；而微信旧内核只认 -webkit- 前缀，
 * 缺了它就只剩 background-color 色块。字符串走 cssText 通道，前缀属性能原样落地。
 */
function styleFor(name: AppIconName): string {
  let cached = styleCache.get(name);
  if (!cached) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
    const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    cached = [
      "background-color: currentColor",
      `-webkit-mask-image: ${mask}`,
      `mask-image: ${mask}`,
      "-webkit-mask-repeat: no-repeat",
      "mask-repeat: no-repeat",
      "-webkit-mask-position: center",
      "mask-position: center",
      "-webkit-mask-size: contain",
      "mask-size: contain",
    ].join("; ");
    styleCache.set(name, cached);
  }
  return cached;
}

interface AppIconProps {
  name: AppIconName;
  /**
   * 尺寸与颜色：必须带 h- 与 w- 尺寸类；颜色用 text-*（含 text-[var(--lb-*)]），
   * 经 currentColor 传给图标。
   */
  className?: string;
}

export default function AppIcon({ name, className = "" }: AppIconProps) {
  return (
    <View className={`shrink-0 ${className}`.trim()} style={styleFor(name)} />
  );
}
