# Shared Theme Package Implementation Plan

> **For agentic workers:** Execute inline in this session. Repository policy forbids commits unless the user explicitly requests them, so this plan intentionally contains no commit steps.

**Goal:** Create `@litter-bear/theme` with four independently defined themes and connect persistent runtime theme switching to every mobile page.

**Architecture:** A pure TypeScript package owns semantic theme definitions and converts them to stable `--lb-*` variables. The mobile app owns a Zustand store, Taro storage, a themed page root, and the theme selection UI; rendering modules consume only CSS variables.

**Tech Stack:** TypeScript ESM, Node test runner, pnpm workspace, Taro 4, React 18, Zustand 5, TailwindCSS 4, weapp-tailwindcss.

---

## File Map

Create:

- `packages/theme/package.json`: workspace package metadata and build/test scripts.
- `packages/theme/tsconfig.json`: ESM declaration build configuration.
- `packages/theme/src/types.ts`: `ThemeId`, `ThemeTokens`, and `ThemeDefinition`.
- `packages/theme/src/css-variables.ts`: stable CSS variable names and token conversion.
- `packages/theme/src/themes/{warm-workbench,mono-tool,soft-companion,purple-gradient}.ts`: one checked definition per theme.
- `packages/theme/src/themes/index.ts`: ordered registry, default ID, lookup, and ID guard.
- `packages/theme/src/index.ts`: public package interface.
- `packages/theme/src/index.test.ts`: registry and CSS conversion tests.
- `apps/mobile/src/store/themeStore.ts`: persisted selected theme.
- `apps/mobile/src/components/PageShell/index.tsx`: themed Taro page root.
- `apps/mobile/src/components/ThemePicker/index.tsx`: four-theme selector.

Modify:

- `apps/mobile/package.json`: add `@litter-bear/theme` workspace dependency.
- `apps/mobile/src/app.ts`: hydrate theme state at launch.
- `apps/mobile/src/app.css`: remove local theme values and retain platform/base consumption rules.
- `apps/mobile/src/utils/constants.ts`: add theme storage key.
- `apps/mobile/src/utils/style.ts`: use semantic background, radius, shadow, and surface classes.
- `apps/mobile/src/pages/*/index.tsx`: replace root `View` with `PageShell`.
- `apps/mobile/src/pages/profile/index.tsx`: render `ThemePicker` as an independent section.
- Shared navigation/chat/status styles: replace remaining theme-specific white backgrounds, fixed radii, and fixed theme colors.
- `docs/design-system.md`: replace planning-only state with the implemented package interface and consumption rules.

## Task 1: Scaffold Package and Lock the Interface with Tests

- [x] Create `packages/theme/package.json` with package name `@litter-bear/theme`, ESM exports from `dist`, and scripts:

```json
{
  "name": "@litter-bear/theme",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "pnpm run build && node --test dist/index.test.js"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  }
}
```

- [x] Create `packages/theme/tsconfig.json` matching the established `packages/types` ESM build, with `strict`, declarations, `rootDir: src`, and `outDir: dist`.

- [x] Write `packages/theme/src/index.test.ts` before implementation. Tests must assert:

```ts
assert.equal(defaultThemeId, "warm-workbench");
assert.deepEqual(
  themes.map((theme) => theme.id),
  ["warm-workbench", "mono-tool", "soft-companion", "purple-gradient"],
);
assert.equal(getTheme("mono-tool").colorScheme, "dark");
assert.equal(isThemeId("soft-companion"), true);
assert.equal(isThemeId("unknown"), false);
assert.equal(
  createThemeCssVariables(getTheme("purple-gradient"))["--lb-accent-surface"],
  "linear-gradient(135deg, #7c3aed, #ec4899 52%, #4f46e5)",
);
```

- [x] Run `pnpm --filter @litter-bear/theme run test` and verify it fails because the public interface does not yet exist.

## Task 2: Implement Types, Four Theme Files, and Registry

- [x] Define `ThemeTokens` in `packages/theme/src/types.ts` with these exact semantic keys:

```ts
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
```

- [x] Define `ThemeId`, `ThemeColorScheme`, and `ThemeDefinition` exactly as approved in the design document. `swatches` must be a non-empty readonly tuple so the selector always has colors to render.

- [x] Create the four theme files. Each exports one object using `as const satisfies ThemeDefinition`; no theme imports another theme or mutates shared defaults.

- [x] Use compatible hex/rgba values based on UI Preview. D must preserve these exact gradients:

```ts
pageBackground: "linear-gradient(135deg, #eef2ff, #f5ecff 52%, #fff0f6)";
accentSurface: "linear-gradient(135deg, #7c3aed, #ec4899 52%, #4f46e5)";
```

- [x] Implement the ordered registry in `packages/theme/src/themes/index.ts`. `getTheme` accepts only `ThemeId`; persisted unknown values are handled through `isThemeId` before lookup.

- [x] Implement `createThemeCssVariables` as a complete explicit mapping, including:

```ts
"--lb-page-background": tokens.pageBackground,
"--lb-bg-start": tokens.background,
"--lb-surface": tokens.surface,
"--lb-accent-surface": tokens.accentSurface,
"--lb-radius-md": tokens.radiusMd,
```

The function must return all token fields and must not infer variable names with string-case manipulation.

- [x] Export only the approved public types/functions/constants from `packages/theme/src/index.ts`.

- [x] Run `pnpm --filter @litter-bear/theme run test`; expect all registry and conversion tests to pass.

## Task 3: Add Mobile Store and Themed Page Root

- [x] Add `@litter-bear/theme: workspace:*` to `apps/mobile/package.json`, then run `pnpm install --lockfile-only` so the workspace lockfile records the dependency without adding unrelated packages.

- [x] Add `THEME: "litter_bear_theme"` to `STORAGE_KEYS`.

- [x] Create `themeStore.ts` with this interface:

```ts
interface ThemeState {
  themeId: ThemeId;
  hydrate: () => void;
  setTheme: (themeId: ThemeId) => void;
}
```

`hydrate` reads `STORAGE_KEYS.THEME`, validates through `isThemeId`, and sets `defaultThemeId` for null or invalid values. `setTheme` persists and updates one state field.

- [x] Call `useThemeStore.getState().hydrate()` from `useLaunch` in `app.ts`.

- [x] Create `PageShell`. It reads the current ID, calls `getTheme` and `createThemeCssVariables`, serializes entries as `name:value`, and renders:

```tsx
<View
  className={`${appPageClass} app-theme-root ${className}`.trim()}
  style={themeStyle}
>
  {children}
</View>
```

- [x] Replace the root `<View className={appPageClass}>` in all five pages with `PageShell`, removing now-unused `View` or `appPageClass` imports only where safe.

- [x] Run mobile typecheck and expect no Taro style or JSX typing errors.

## Task 4: Add the Profile Theme Picker

- [x] Create `ThemePicker` using the shared `themes` array and mobile store. Render a two-column grid of four repeated options with a minimum 48px touch height.

- [x] Each option renders `shortName`, `name`, three `swatches`, and a check icon for the active theme. Use semantic variables for its border, surface, text, and selected state; do not embed theme palette values in the module.

- [x] Add an unframed “界面主题” section to the Profile page above the existing settings list. Do not put the theme options inside an existing card.

- [x] Ensure changing theme does not trigger navigation, logout, chat clearing, or any API operation.

## Task 5: Migrate Mobile Visual Consumers

- [x] Remove the theme value block from `app.css`. Keep fallback A variables only in `:root` so the first render before hydration remains readable; add a comment that these values are the startup fallback and the package is the source of truth.

- [x] Add platform consumption classes:

```css
.app-theme-root {
  background: var(--lb-page-background);
}
.app-accent-surface {
  background: var(--lb-accent-surface);
}
```

- [x] Change `appGradientSurfaceClass` to use `app-accent-surface`; change page/card/input/radius/shadow utility strings to `--lb-*` variables.

- [x] Replace visually significant `bg-white` instances with `bg-[var(--lb-surface)]`, fixed card/control radii with `--lb-radius-*`, and fixed theme shadows with shared shadow variables. Preserve circular avatars, pills, and status dots as circles.

- [x] Update SCSS modules for approval, stream feedback, streaming markdown, and waiting feedback to consume semantic variables. Code blocks may keep a deliberate dark code surface because it is content syntax styling, not application chrome.

- [x] Scan `apps/mobile/src` for purple palette literals and duplicated A/B/C/D palette definitions. Theme values must live only under `packages/theme/src/themes` plus the documented A startup fallback in `app.css`.

## Task 6: Documentation and Verification

- [x] Update `docs/design-system.md` to document the implemented package, its public interface, theme IDs, mobile adapter, and rule that app modules do not define theme palettes.

- [x] Run formatting on all changed source and documentation files.

- [x] Run:

```bash
pnpm --filter @litter-bear/theme run test
pnpm --filter ./apps/mobile run typecheck
pnpm --filter ./apps/mobile run build:weapp
pnpm --filter ./apps/mobile run build:h5
```

Expected: package tests pass, TypeScript exits 0, and both Taro targets complete production builds.

- [x] Run `git diff --check` and verify only intended files changed. Preserve `.vscode/settings.json` and all pre-existing user changes.
