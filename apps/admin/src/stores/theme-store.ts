import { create } from "zustand";
import {
  createThemeCssVariables,
  defaultThemeId,
  getPixelTheme,
  getTheme,
  isPixelThemeId,
  isThemeId,
  type AnyThemeId,
} from "@litter-bear/theme";

const STORAGE_KEY = "litter_bear_admin_theme";

/** 把选中主题的 --lb-* 变量写入 :root；像素主题额外挂 .theme-pixel + data-pixel 供专属 CSS 钩子 */
function applyTheme(themeId: AnyThemeId) {
  const pixel = isPixelThemeId(themeId);
  const theme = pixel ? getPixelTheme(themeId) : getTheme(themeId);
  const variables = createThemeCssVariables(theme);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.classList.toggle("theme-pixel", pixel);
  if (pixel) {
    root.setAttribute("data-pixel", themeId);
  } else {
    root.removeAttribute("data-pixel");
  }
}

function normalizeThemeId(value: unknown): AnyThemeId {
  if (isThemeId(value) || isPixelThemeId(value)) {
    return value;
  }
  return defaultThemeId;
}

interface ThemeState {
  themeId: AnyThemeId;
  setTheme: (themeId: AnyThemeId) => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: defaultThemeId,

  setTheme(themeId) {
    localStorage.setItem(STORAGE_KEY, themeId);
    applyTheme(themeId);
    set({ themeId });
  },

  hydrate() {
    const themeId = normalizeThemeId(localStorage.getItem(STORAGE_KEY));
    applyTheme(themeId);
    set({ themeId });
  },
}));
