import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readProjectFile(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

test("theme tokens include reader surface and nav icon variables", () => {
  const tokens = readProjectFile("static/css/themes/theme-tokens.css");
  assert.match(tokens, /--reader-page-surface:/);
  assert.match(tokens, /--reader-shell-border:/);
  assert.match(tokens, /--reader-surface-bg:/);
  assert.match(tokens, /--nav-icon-bg-top:/);
  assert.match(tokens, /--nav-icon-color:/);
});

test("theme tokens do not contain deprecated close-specific overrides", () => {
  const tokens = readProjectFile("static/css/themes/theme-tokens.css");
  assert.doesNotMatch(tokens, /--nav-close-/);
});

test("theme overrides keep wrapper-main as background host and epub viewport transparent", () => {
  const overrides = readProjectFile("static/css/themes/theme-overrides.css");
  assert.match(overrides, /\.wrapper-main\s*\{\s*background:\s*var\(--reader-background,\s*var\(--page-background\)\);/);
  assert.match(overrides, /\.reader-wrapper-container\s*\{\s*background:\s*transparent\s*!important;/);
  assert.match(overrides, /\[id\^="epubjs-container-"\]\s*\{[\s\S]*background:\s*transparent\s*!important;/);
});

test("navigation icons are inline SVG based", () => {
  const html = readProjectFile("index.html");
  assert.match(html, /class="iconfont"[^>]*>\s*<svg/);
  assert.match(html, /<circle cx="12" cy="12" r="8\.25"><\/circle>/);
});
