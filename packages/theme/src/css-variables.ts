import type { ThemeDefinition } from "./types.js";

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

export function createThemeCssVariables(
  theme: ThemeDefinition,
): ThemeCssVariables {
  const { tokens } = theme;

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
