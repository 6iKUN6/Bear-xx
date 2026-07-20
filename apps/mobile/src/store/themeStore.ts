import { defaultThemeId, isThemeId, type ThemeId } from "@litter-bear/theme";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { createBoundStore } from "./createBoundStore";

interface ThemeState {
  themeId: ThemeId;
  hydrate: () => void;
  setTheme: (themeId: ThemeId) => void;
}

export const useThemeStore = createBoundStore<ThemeState>((set) => ({
  themeId: defaultThemeId,

  hydrate() {
    const storedThemeId = storage.get<unknown>(STORAGE_KEYS.THEME);
    set({
      themeId: isThemeId(storedThemeId) ? storedThemeId : defaultThemeId,
    });
  },

  setTheme(themeId) {
    storage.set(STORAGE_KEYS.THEME, themeId);
    set({ themeId });
  },
}));
