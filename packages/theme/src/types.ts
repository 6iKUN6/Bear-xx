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
  colorScheme: ThemeColorScheme;
  tokens: ThemeTokens;
  swatches: readonly [string, string, string];
}
