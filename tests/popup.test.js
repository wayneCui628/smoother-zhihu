const test = require("node:test");
const assert = require("node:assert/strict");

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
