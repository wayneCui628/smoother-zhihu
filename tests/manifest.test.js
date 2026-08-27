const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const projectRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(projectRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

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
