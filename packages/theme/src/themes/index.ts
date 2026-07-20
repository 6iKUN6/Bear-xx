import type { ThemeDefinition, ThemeId } from "../types.js";
import { monoToolTheme } from "./mono-tool.js";
import { purpleGradientTheme } from "./purple-gradient.js";
import { softCompanionTheme } from "./soft-companion.js";
import { warmWorkbenchTheme } from "./warm-workbench.js";

export const defaultThemeId: ThemeId = "warm-workbench";

export const themes = [
  warmWorkbenchTheme,
  monoToolTheme,
  softCompanionTheme,
  purpleGradientTheme,
] as const satisfies readonly ThemeDefinition[];

const themeById: Record<ThemeId, ThemeDefinition> = {
  "warm-workbench": warmWorkbenchTheme,
  "mono-tool": monoToolTheme,
  "soft-companion": softCompanionTheme,
  "purple-gradient": purpleGradientTheme,
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
