import assert from "node:assert/strict";
import test from "node:test";
import {
  createThemeCssVariables,
  defaultThemeId,
  getTheme,
  isThemeId,
  resolveThemeTokens,
  themes,
} from "./index.js";

test("registers the four themes in preview order", () => {
  assert.equal(defaultThemeId, "warm-workbench");
  assert.deepEqual(
    themes.map((theme) => theme.id),
    ["warm-workbench", "mono-tool", "soft-companion", "purple-gradient"],
  );
});

test("exposes the dark color scheme for the mono theme", () => {
  assert.equal(getTheme("mono-tool").colorScheme, "dark");
});

test("validates persisted theme ids as a closed set", () => {
  assert.equal(isThemeId("soft-companion"), true);
  assert.equal(isThemeId("unknown"), false);
  assert.equal(isThemeId(null), false);
});

test("maps the purple gradient theme to stable CSS variables", () => {
  const variables = createThemeCssVariables(getTheme("purple-gradient"));

  assert.equal(
    variables["--lb-accent-surface"],
    "linear-gradient(135deg, #7c3aed, #ec4899 52%, #4f46e5)",
  );
  assert.equal(
    variables["--lb-page-background"],
    "linear-gradient(135deg, #eef2ff, #f5ecff 52%, #fff0f6)",
  );
  assert.equal(variables["--lb-radius-md"], "1rem");
});

test("resolves the default tokens when no mode is given", () => {
  const theme = getTheme("warm-workbench");
  assert.equal(resolveThemeTokens(theme), theme.tokens);
  assert.equal(resolveThemeTokens(theme, "light"), theme.tokens);
});

test("resolves the dark variant for light themes and vice versa", () => {
  const light = getTheme("warm-workbench");
  assert.equal(light.colorScheme, "light");
  assert.equal(resolveThemeTokens(light, "dark"), light.dark);

  const dark = getTheme("mono-tool");
  assert.equal(dark.colorScheme, "dark");
  assert.equal(resolveThemeTokens(dark, "light"), dark.light);
});

test("maps the dark variant to CSS variables when mode is dark", () => {
  const theme = getTheme("warm-workbench");
  const darkVars = createThemeCssVariables(theme, "dark");
  assert.equal(darkVars["--lb-page-background"], "#1c1815");
  // 默认模式不受影响
  const lightVars = createThemeCssVariables(theme);
  assert.equal(lightVars["--lb-page-background"], "#f2f3f5");
});

test("every theme ships both light and dark palettes", () => {
  for (const theme of themes) {
    const variant = theme.colorScheme === "light" ? theme.dark : theme.light;
    assert.ok(
      variant,
      `${theme.id} 缺少 ${theme.colorScheme === "light" ? "dark" : "light"} 变体`,
    );
    // 变体应是另一模式的完整色板：页面底色应与默认模式不同
    assert.notEqual(variant.pageBackground, theme.tokens.pageBackground);
  }
});
