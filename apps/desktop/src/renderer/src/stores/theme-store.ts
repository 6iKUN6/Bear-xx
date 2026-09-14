import { create } from "zustand";
import {
  createThemeCssVariables,
  defaultThemeId,
  getTheme,
  isThemeId,
  type ThemeColorScheme,
  type ThemeId,
} from "@litter-bear/theme";

const THEME_STORAGE_KEY = "sola_desktop_theme";
const MODE_STORAGE_KEY = "sola_desktop_theme_mode";

/** 把主题 + 模式的 --lb-* 变量写入 :root（与 admin 同款：主题有深/浅变体，缺变体时回退默认色板） */
function applyTheme(themeId: ThemeId, mode: ThemeColorScheme) {
  const root = document.documentElement;
  const variables = createThemeCssVariables(getTheme(themeId), mode);
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
  root.style.colorScheme = mode;
}

function normalizeMode(value: unknown): ThemeColorScheme {
  return value === "dark" ? "dark" : "light";
}

interface ThemeState {
  themeId: ThemeId;
  /** 当前生效的深浅模式 */
  mode: ThemeColorScheme;
  setTheme: (themeId: ThemeId) => void;
  setMode: (mode: ThemeColorScheme) => void;
  /** 应用启动时读取本地持久化并注入变量；须在首屏渲染前调用 */
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: defaultThemeId,
  mode: getTheme(defaultThemeId).colorScheme,

  setTheme(themeId) {
    // 切主题时跟随该主题的默认模式（深/浅主题各自的「原生」观感），用户可再用开关覆盖
    const mode = getTheme(themeId).colorScheme;
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    applyTheme(themeId, mode);
    set({ themeId, mode });
  },

  setMode(mode) {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    applyTheme(get().themeId, mode);
    set({ mode });
  },

  hydrate() {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const themeId = isThemeId(storedTheme) ? storedTheme : defaultThemeId;
    const storedMode = localStorage.getItem(MODE_STORAGE_KEY);
    const mode = normalizeMode(storedMode ?? getTheme(themeId).colorScheme);
    applyTheme(themeId, mode);
    set({ themeId, mode });
  },
}));
