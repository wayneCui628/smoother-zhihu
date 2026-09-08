const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INCLUDES,
  EXCLUDES,
  crc32,
  collectEntries,
  buildZipBuffer,
  validateZipBuffer,
} = require("../scripts/pack.js");

const projectRoot = path.resolve(__dirname, "..");

function createFixtureTree(dir) {
  fs.mkdirSync(path.join(dir, "src/assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src/content"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), '{"manifest_version": 3}');
  fs.writeFileSync(path.join(dir, "src/content/content.js"), "// fixture");
  fs.writeFileSync(path.join(dir, "src/assets/icon-16.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, "src/assets/icon-512.png"), "excluded big icon");
  fs.writeFileSync(path.join(dir, "src/assets/icon.svg"), "<svg/>");
  fs.writeFileSync(path.join(dir, "LICENSE"), "MIT");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture");
}

// Walks local file headers sequentially and inflates each payload back out,
// so the byte layout itself is what gets verified.
function readLocalEntries(buffer) {
  const entries = [];
  let pos = 0;
  while (pos + 4 <= buffer.length && buffer.readUInt32LE(pos) === 0x04034b50) {
    const method = buffer.readUInt16LE(pos + 8);
    const flags = buffer.readUInt16LE(pos + 6);
    const crc = buffer.readUInt32LE(pos + 14);
    const compressedSize = buffer.readUInt32LE(pos + 18);
    const uncompressedSize = buffer.readUInt32LE(pos + 22);
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const name = buffer.toString("utf8", pos + 30, pos + 30 + nameLength);
    const dataStart = pos + 30 + nameLength + extraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    entries.push({ name, data, crc, uncompressedSize, flags });
    pos = dataStart + compressedSize;
  }
  return entries;
}

test("collectEntries emits forward-slash names and applies the exclude list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoother-zhihu-pack-"));
  try {
    createFixtureTree(dir);
    const entries = collectEntries(dir, INCLUDES, EXCLUDES);
    const names = entries.map((entry) => entry.name);

    assert.ok(names.every((name) => !name.includes("\\")), `backslash in entry names: ${names}`);
    assert.ok(names.includes("manifest.json"));
    assert.ok(names.includes("src/content/content.js"));
    assert.ok(names.includes("src/assets/icon-16.png"));
    for (const excluded of EXCLUDES) {
      assert.ok(!names.includes(excluded), `excluded file leaked into archive: ${excluded}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectEntries skips symlinks when a filesystem permits creating them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoother-zhihu-pack-"));
  try {
    createFixtureTree(dir);
    let symlinkReady = false;
    try {
      fs.symlinkSync(path.join(dir, "LICENSE"), path.join(dir, "src/assets/LICENSE-link"));
      symlinkReady = true;
    } catch (_error) {
      // Windows without symlink privilege: nothing to assert here.
    }
    const names = collectEntries(dir, INCLUDES, EXCLUDES).map((entry) => entry.name);
    if (symlinkReady) {
      assert.ok(!names.includes("src/assets/LICENSE-link"), "symlink must not be packed");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("zip entries roundtrip with matching bytes, sizes, and CRC values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoother-zhihu-pack-"));
  try {
    createFixtureTree(dir);
    fs.writeFileSync(path.join(dir, "src/empty.txt"), "");
    const entries = collectEntries(dir, INCLUDES, EXCLUDES);
    const buffer = buildZipBuffer(entries);
    const restored = readLocalEntries(buffer);

    assert.equal(restored.length, entries.length);
    for (let i = 0; i < entries.length; i++) {
      assert.equal(restored[i].name, entries[i].name);
      assert.ok(restored[i].data.equals(entries[i].data), `content mismatch for ${entries[i].name}`);
      assert.equal(restored[i].crc, crc32(entries[i].data));
      assert.equal(restored[i].uncompressedSize, entries[i].data.length);
    }

    const empty = restored.find((entry) => entry.name === "src/empty.txt");
    assert.ok(empty, "empty file must be present in the archive");
    assert.equal(empty.data.length, 0);
    assert.equal(empty.crc, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("crc32 matches the standard check values", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("")), 0x00000000);
});

test("validateZipBuffer accepts generated archives and returns central directory names", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from("{}") },
    { name: "src/content/content.js", data: Buffer.from("// ok") },
  ];
  const names = validateZipBuffer(buildZipBuffer(entries));
  assert.deepEqual(names, ["manifest.json", "src/content/content.js"]);
});

test("validateZipBuffer rejects backslash entry names", () => {
  const entries = [{ name: "src\\content\\content.js", data: Buffer.from("// bad") }];
  assert.throws(() => validateZipBuffer(buildZipBuffer(entries)), /illegal entry name/);
});

test("validateZipBuffer rejects parent-directory path segments", () => {
  const entries = [{ name: "../evil.txt", data: Buffer.from("bad") }];
  assert.throws(() => validateZipBuffer(buildZipBuffer(entries)), /illegal entry name/);
});

test("buildZipBuffer output is deterministic", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from("{}") },
    { name: "src/popup/popup.js", data: Buffer.from("void 0") },
  ];
  assert.ok(buildZipBuffer(entries).equals(buildZipBuffer(entries)));
});

test("the real project packs with every manifest asset inside a spec-compliant archive", () => {
  const entries = collectEntries(projectRoot, INCLUDES, EXCLUDES);
  const buffer = buildZipBuffer(entries);
  const names = validateZipBuffer(buffer);

  assert.ok(names.includes("manifest.json"), "manifest.json must sit at the archive root");

  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "manifest.json"), "utf8"));
  const contentScript = manifest.content_scripts[0];
  const referenced = [
    manifest.action.default_popup,
    ...contentScript.css,
    ...contentScript.js,
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action.default_icon || {}),
  ];
  for (const asset of referenced) {
    assert.ok(names.includes(asset), `manifest-referenced asset missing from archive: ${asset}`);
  }
});

test("non-ASCII entry names set the UTF-8 flag (bit 11), ASCII names keep flags at 0", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from("{}") },
    { name: "src/中文.txt", data: Buffer.from("中文内容") },
  ];
  const restored = readLocalEntries(buildZipBuffer(entries));

  const asciiEntry = restored.find((entry) => entry.name === "manifest.json");
  const utf8Entry = restored.find((entry) => entry.name === "src/中文.txt");
  assert.ok(asciiEntry, "ASCII entry missing from parsed archive");
  assert.ok(utf8Entry, "non-ASCII entry missing from parsed archive");
  assert.equal(asciiEntry.flags, 0);
  assert.ok(utf8Entry.flags & 0x0800, `UTF-8 flag not set for non-ASCII name: flags=${utf8Entry.flags}`);
});
