export type ThemeId =
  "warm-workbench" | "mono-tool" | "soft-companion" | "purple-gradient";

/** 像素风主题 id（独立于 ThemeId：仅 admin 消费，不进 mobile 的 themes 列表） */
export type PixelThemeId =
  "pixel-neo" | "pixel-gb" | "pixel-crt" | "pixel-arcade";

export type AnyThemeId = ThemeId | PixelThemeId;

export type ThemeColorScheme = "light" | "dark";

export interface ThemeTokens {
  pageBackground: string;
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceMuted: string;
  surfaceHover: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentInk: string;
  accentSurface: string;
  onAccent: string;
  success: string;
  successSoft: string;
  info: string;
  infoSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  shadowCard: string;
  shadowFloat: string;
  radiusXs: string;
  radiusSm: string;
  radiusMd: string;
}

export interface ThemeDefinition {
  id: AnyThemeId;
  name: string;
  shortName: string;
  description: string;
  /**
   * 默认色彩模式：`tokens` 对应这一模式的色板。
   * 浅色主题（colorScheme:"light"）的 `tokens` 是浅色板，深色变体放 `dark`；
   * 深色主题（colorScheme:"dark"）反之，浅色变体放 `light`。
   */
  colorScheme: ThemeColorScheme;
  tokens: ThemeTokens;
  /** 深色变体；仅浅色主题提供。缺省时该主题无深色模式。 */
  dark?: ThemeTokens;
  /** 浅色变体；仅深色主题提供。缺省时该主题无浅色模式。 */
  light?: ThemeTokens;
  swatches: readonly [string, string, string];
}
