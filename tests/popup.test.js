const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const popupCss = fs.readFileSync(path.join(projectRoot, "src/popup/popup.css"), "utf8");

const { normalizeConfig, DEFAULT_CONFIG } = require("../src/popup/popup.js");

test("popup normalizeConfig preserves valid custom minAnswers", () => {
  const config = normalizeConfig({
    enabled: true,
    bufferViewports: 4,
    minAnswers: 20,
    showPageWidget: false,
  });

  assert.equal(config.enabled, true);
  assert.equal(config.bufferViewports, 4);
  assert.equal(config.minAnswers, 20);
  assert.equal(config.showPageWidget, false);
});

test("popup normalizeConfig falls back to default minAnswers when invalid", () => {
  const config = normalizeConfig({
    minAnswers: "invalid",
  });

  assert.equal(config.minAnswers, DEFAULT_CONFIG.minAnswers);
  assert.equal(normalizeConfig({ minAnswers: null }).minAnswers, DEFAULT_CONFIG.minAnswers);
  assert.equal(normalizeConfig({ minAnswers: "" }).minAnswers, DEFAULT_CONFIG.minAnswers);
});

test("popup normalizeConfig migrates legacy minAnswers 12 to new default 5", () => {
  const fromNumber = normalizeConfig({ minAnswers: 12 });
  const fromString = normalizeConfig({ minAnswers: "12" });

  assert.equal(fromNumber.minAnswers, 5);
  assert.equal(fromString.minAnswers, 5);
});

test("popup normalizeConfig supports 1/2/4 viewport modes and handles invalid buffer", () => {
  assert.equal(normalizeConfig({ bufferViewports: 1 }).bufferViewports, 1);
  assert.equal(normalizeConfig({ bufferViewports: 2 }).bufferViewports, 2);
  assert.equal(normalizeConfig({ bufferViewports: 4 }).bufferViewports, 4);
  assert.equal(normalizeConfig({ bufferViewports: 99 }).bufferViewports, DEFAULT_CONFIG.bufferViewports);
  assert.equal(DEFAULT_CONFIG.bufferViewports, 2);
});

test("popup css declares a light-dark color scheme with a dark palette", () => {
  assert.match(popupCss, /color-scheme:\s*light dark;/);
  assert.match(popupCss, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--bg:\s*#1e1e1e;/);
  assert.match(popupCss, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--ink:\s*#e2e2e2;/);
  assert.match(popupCss, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--blue-text:\s*#4a9eff;/);
});
