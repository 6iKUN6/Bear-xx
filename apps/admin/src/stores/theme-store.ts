import { create } from "zustand";
import {
  createThemeCssVariables,
  defaultThemeId,
  getPixelTheme,
  getTheme,
  isPixelThemeId,
  isThemeId,
  type AnyThemeId,
  type ThemeColorScheme,
} from "@litter-bear/theme";

const THEME_STORAGE_KEY = "litter_bear_admin_theme";
const MODE_STORAGE_KEY = "litter_bear_admin_theme_mode";

function readTheme(themeId: AnyThemeId) {
  return isPixelThemeId(themeId) ? getPixelTheme(themeId) : getTheme(themeId);
}

/** 把选中主题 + 模式的 --lb-* 变量写入 :root；像素主题额外挂 .theme-pixel + data-pixel 供专属 CSS 钩子 */
function applyTheme(themeId: AnyThemeId, mode: ThemeColorScheme) {
  const pixel = isPixelThemeId(themeId);
  const theme = readTheme(themeId);
  const variables = createThemeCssVariables(theme, mode);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.classList.toggle("theme-pixel", pixel);
  root.dataset.themeMode = mode;
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

function normalizeMode(value: unknown): ThemeColorScheme {
  return value === "dark" ? "dark" : "light";
}

interface ThemeState {
  themeId: AnyThemeId;
  /** 当前生效的深浅模式；落到 document 的 data-theme-mode 供 CSS 区分 */
  mode: ThemeColorScheme;
  setTheme: (themeId: AnyThemeId) => void;
  setMode: (mode: ThemeColorScheme) => void;
  toggleMode: () => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: defaultThemeId,
  mode: "light",

  setTheme(themeId) {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
    // 切主题时跟随该主题的默认模式（深/浅主题各自的「原生」观感），用户可再用开关覆盖
    const mode = readTheme(themeId).colorScheme;
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    applyTheme(themeId, mode);
    set({ themeId, mode });
  },

  setMode(mode) {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    applyTheme(get().themeId, mode);
    set({ mode });
  },

  toggleMode() {
    get().setMode(get().mode === "dark" ? "light" : "dark");
  },

  hydrate() {
    const themeId = normalizeThemeId(localStorage.getItem(THEME_STORAGE_KEY));
    const mode = normalizeMode(localStorage.getItem(MODE_STORAGE_KEY));
    applyTheme(themeId, mode);
    set({ themeId, mode });
  },
}));
