import type {
  PixelThemeId,
  ThemeDefinition,
  ThemeId,
} from "../types.js";
import { monoToolTheme } from "./mono-tool.js";
import { purpleGradientTheme } from "./purple-gradient.js";
import { softCompanionTheme } from "./soft-companion.js";
import { warmWorkbenchTheme } from "./warm-workbench.js";
import { pixelNeoTheme } from "./pixel-neo.js";
import { pixelGbTheme } from "./pixel-gb.js";
import { pixelCrtTheme } from "./pixel-crt.js";
import { pixelArcadeTheme } from "./pixel-arcade.js";

export const defaultThemeId: ThemeId = "warm-workbench";

/** 端侧（mobile）与 admin 共享的常规主题；mobile 只消费这一组 */
export const themes = [
  warmWorkbenchTheme,
  monoToolTheme,
  softCompanionTheme,
  purpleGradientTheme,
] as const satisfies readonly ThemeDefinition[];

/** 像素风主题：仅 admin 消费，不并入 themes（避免污染 mobile 选择器） */
export const pixelThemes = [
  pixelNeoTheme,
  pixelGbTheme,
  pixelCrtTheme,
  pixelArcadeTheme,
] as const satisfies readonly ThemeDefinition[];

const themeById: Record<ThemeId, ThemeDefinition> = {
  "warm-workbench": warmWorkbenchTheme,
  "mono-tool": monoToolTheme,
  "soft-companion": softCompanionTheme,
  "purple-gradient": purpleGradientTheme,
};

const pixelThemeById: Record<PixelThemeId, ThemeDefinition> = {
  "pixel-neo": pixelNeoTheme,
  "pixel-gb": pixelGbTheme,
  "pixel-crt": pixelCrtTheme,
  "pixel-arcade": pixelArcadeTheme,
};

export function getTheme(themeId: ThemeId): ThemeDefinition {
  return themeById[themeId];
}

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(themeById, value)
  );
}

export function getPixelTheme(themeId: PixelThemeId): ThemeDefinition {
  return pixelThemeById[themeId];
}

export function isPixelThemeId(value: unknown): value is PixelThemeId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(pixelThemeById, value)
  );
}
