import type {
  ThemeColorScheme,
  ThemeDefinition,
  ThemeTokens,
} from "./types.js";

const themeCssVariableNames = {
  pageBackground: "--lb-page-background",
  background: "--lb-bg-start",
  surface: "--lb-surface",
  surfaceRaised: "--lb-surface-strong",
  surfaceMuted: "--lb-surface-muted",
  surfaceHover: "--lb-surface-hover",
  textPrimary: "--lb-text-primary",
  textSecondary: "--lb-text-secondary",
  textMuted: "--lb-text-muted",
  line: "--lb-line-soft",
  lineStrong: "--lb-line-strong",
  accent: "--lb-accent",
  accentStrong: "--lb-accent-strong",
  accentSoft: "--lb-accent-soft",
  accentInk: "--lb-accent-ink",
  accentSurface: "--lb-accent-surface",
  onAccent: "--lb-on-accent",
  success: "--lb-success",
  successSoft: "--lb-success-soft",
  info: "--lb-info",
  infoSoft: "--lb-info-soft",
  warning: "--lb-warning",
  warningSoft: "--lb-warning-soft",
  danger: "--lb-danger",
  dangerSoft: "--lb-danger-soft",
  shadowCard: "--lb-shadow-card",
  shadowFloat: "--lb-shadow-glow",
  radiusXs: "--lb-radius-xs",
  radiusSm: "--lb-radius-sm",
  radiusMd: "--lb-radius-md",
} as const;

export type ThemeCssVariableName =
  (typeof themeCssVariableNames)[keyof typeof themeCssVariableNames];

export type ThemeCssVariables = Readonly<Record<ThemeCssVariableName, string>>;

/**
 * 取指定模式下的色板。
 * @param theme 主题定义
 * @param mode 目标模式；缺省用主题的默认 `colorScheme`
 * @returns 该模式的 token；主题未提供对应变体时回退到默认 `tokens`
 * @description 浅色主题把深色板放 `dark`，深色主题把浅色板放 `light`；
 * 取默认模式时直接返回 `tokens`，保持既有调用语义不变。
 */
export function resolveThemeTokens(
  theme: ThemeDefinition,
  mode?: ThemeColorScheme,
): ThemeTokens {
  const target = mode ?? theme.colorScheme;
  if (target === theme.colorScheme) {
    return theme.tokens;
  }
  return (target === "dark" ? theme.dark : theme.light) ?? theme.tokens;
}

export function createThemeCssVariables(
  theme: ThemeDefinition,
  mode?: ThemeColorScheme,
): ThemeCssVariables {
  const tokens = resolveThemeTokens(theme, mode);

  return {
    "--lb-page-background": tokens.pageBackground,
    "--lb-bg-start": tokens.background,
    "--lb-surface": tokens.surface,
    "--lb-surface-strong": tokens.surfaceRaised,
    "--lb-surface-muted": tokens.surfaceMuted,
    "--lb-surface-hover": tokens.surfaceHover,
    "--lb-text-primary": tokens.textPrimary,
    "--lb-text-secondary": tokens.textSecondary,
    "--lb-text-muted": tokens.textMuted,
    "--lb-line-soft": tokens.line,
    "--lb-line-strong": tokens.lineStrong,
    "--lb-accent": tokens.accent,
    "--lb-accent-strong": tokens.accentStrong,
    "--lb-accent-soft": tokens.accentSoft,
    "--lb-accent-ink": tokens.accentInk,
    "--lb-accent-surface": tokens.accentSurface,
    "--lb-on-accent": tokens.onAccent,
    "--lb-success": tokens.success,
    "--lb-success-soft": tokens.successSoft,
    "--lb-info": tokens.info,
    "--lb-info-soft": tokens.infoSoft,
    "--lb-warning": tokens.warning,
    "--lb-warning-soft": tokens.warningSoft,
    "--lb-danger": tokens.danger,
    "--lb-danger-soft": tokens.dangerSoft,
    "--lb-shadow-card": tokens.shadowCard,
    "--lb-shadow-glow": tokens.shadowFloat,
    "--lb-radius-xs": tokens.radiusXs,
    "--lb-radius-sm": tokens.radiusSm,
    "--lb-radius-md": tokens.radiusMd,
  };
}
