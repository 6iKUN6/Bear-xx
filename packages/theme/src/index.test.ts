import assert from "node:assert/strict";
import test from "node:test";
import {
  createThemeCssVariables,
  defaultThemeId,
  getTheme,
  isThemeId,
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
