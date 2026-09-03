const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const projectRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(projectRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

test("manifest is a focused Manifest V3 extension", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.background, undefined);
  assert.equal(manifest.host_permissions, undefined);
});

test("all manifest assets exist and the virtualizer loads first", () => {
  const contentScript = manifest.content_scripts.at(0);
  assert.deepEqual(contentScript.js, [
    "src/content/virtualizer.js",
    "src/content/page-widget.js",
    "src/content/content.js",
  ]);

  const assets = [
    manifest.action.default_popup,
    ...contentScript.css,
    ...contentScript.js,
  ];

  for (const asset of assets) {
    assert.equal(
      fs.existsSync(path.join(projectRoot, asset)),
      true,
      `Missing extension asset: ${asset}`,
    );
  }
});

test("content script access is limited to Zhihu question pages", () => {
  const matches = manifest.content_scripts.flatMap((entry) => entry.matches);
  assert.ok(matches.length > 0);
  assert.ok(matches.every((pattern) => /zhihu\.com\/question\/\*$/.test(pattern)));
});

test("release metadata and real-page performance CSS stay aligned", () => {
  assert.equal(manifest.version, "0.3.18");
  assert.equal(packageJson.version, manifest.version);

  const css = fs.readFileSync(path.join(projectRoot, "src/content/content.css"), "utf8");
  assert.doesNotMatch(css, /content-visibility:\s*auto/);
  assert.match(css, /\.zhihu-smoother-answer\.zhihu-smoother-parked\s*\{[\s\S]*content-visibility:\s*hidden;/);
  assert.doesNotMatch(css, /\.zhihu-smoother-placeholder\s*\{/);
  assert.match(css, /\.QuestionAnswers-answers \.Pc-word-new\s*\{[\s\S]*display:\s*none !important;/);
  assert.match(css, /\.Question-sideColumn\s*\{[\s\S]*contain:\s*layout;/);
  assert.match(css, /\.QuestionAnswers-answers div\[role="listitem"\]:empty:not\(:first-child\)/);
  assert.match(css, /\.zhihu-smoother-answer\.zhihu-smoother-parked img\s*\{[\s\S]*content-visibility:\s*hidden !important;/);
  assert.match(css, /@media print\s*\{[\s\S]*\.zhihu-smoother-answer\.zhihu-smoother-parked img\s*\{[\s\S]*content-visibility:\s*visible !important;/);
  assert.match(css, /html\[data-theme="dark"\]\s+\.zhihu-smoother-page-widget/);
});
