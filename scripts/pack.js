// Pure-Node zip writer. The previous Windows branch shelled out to PowerShell
// Compress-Archive, which emits backslash entry names and violates the ZIP
// spec (APPNOTE 4.4.17.1); Chrome Web Store rejects such archives. Writing the
// archive ourselves keeps one code path for every platform.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const INCLUDES = ["manifest.json", "src", "LICENSE", "README.md"];
// Neither file is referenced by manifest.json: the 512px icon belongs to
// store listings and the svg is the design source for the shipped PNGs.
const EXCLUDES = ["src/assets/icon-512.png", "src/assets/icon.svg"];

// A fixed timestamp keeps builds byte-for-byte reproducible for a given Node/zlib build (deflate output can vary across zlib versions).
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function collectEntries(root, includes, excludes) {
  const excluded = new Set(excludes);
  const entries = [];
  const walk = (absPath, name) => {
    const stat = fs.lstatSync(absPath);
    if (stat.isFile()) {
      if (!excluded.has(name)) {
        entries.push({ name, data: fs.readFileSync(absPath) });
      }
      return;
    }
    if (!stat.isDirectory()) {
      // Skip symlinks and other special files: the archive should mirror only
      // git-tracked real files.
      return;
    }
    for (const child of fs.readdirSync(absPath).sort()) {
      walk(path.join(absPath, child), `${name}/${child}`);
    }
  };
  for (const include of includes) {
    walk(path.join(root, include), include);
  }
  return entries;
}

function localHeader(nameBuf, flags, crc, compressedSize, uncompressedSize) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed to extract
  header.writeUInt16LE(flags, 6); // flags
  header.writeUInt16LE(8, 8); // method: deflate
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return header;
}

function centralHeader(nameBuf, flags, crc, compressedSize, uncompressedSize, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); // central directory signature
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed to extract
  header.writeUInt16LE(flags, 8); // flags
  header.writeUInt16LE(8, 10); // method: deflate
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBuf.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal attrs
  header.writeUInt32LE(0, 38); // external attrs
  header.writeUInt32LE(offset, 42); // local header offset
  return header;
}

function endRecord(count, cdSize, cdOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(cdSize, 12);
  record.writeUInt32LE(cdOffset, 16);
  record.writeUInt16LE(0, 20); // comment length
  return record;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const flags = /^[\x00-\x7F]*$/.test(entry.name) ? 0 : 0x0800;
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    localParts.push(
      localHeader(nameBuf, flags, crc, compressed.length, entry.data.length),
      nameBuf,
      compressed,
    );
    centralParts.push(
      centralHeader(nameBuf, flags, crc, compressed.length, entry.data.length, offset),
      nameBuf,
    );
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([...localParts, centralDirectory, endRecord(entries.length, centralDirectory.length, offset)]);
}

// Parses the central directory back out of an archive so pack can prove its
// own output is store-ready: forward-slash names only, manifest.json at root.
function validateZipBuffer(buffer) {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) {
    throw new Error("zip validation failed: end of central directory record not found");
  }
  const count = buffer.readUInt16LE(eocdOffset + 10);
  let pos = buffer.readUInt32LE(eocdOffset + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`zip validation failed: malformed central directory entry #${i}`);
    }
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLength);
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) {
      throw new Error(`zip validation failed: illegal entry name "${name}"`);
    }
    names.push(name);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function main() {
  const root = path.join(__dirname, "..");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const zipPath = path.join(dist, `smoother-zhihu-v${pkg.version}.zip`);

  const entries = collectEntries(root, INCLUDES, EXCLUDES);
  if (!entries.some((entry) => entry.name === "manifest.json")) {
    throw new Error("pack aborted: manifest.json is missing from the archive");
  }
  const buffer = buildZipBuffer(entries);
  const names = validateZipBuffer(buffer);
  if (!names.includes("manifest.json")) {
    throw new Error("pack aborted: manifest.json is not at the archive root");
  }
  fs.writeFileSync(zipPath, buffer);
  console.log(`打包成功: ${zipPath} (${names.length} 个文件, ${buffer.length} 字节)`);
}

module.exports = { INCLUDES, EXCLUDES, crc32, collectEntries, buildZipBuffer, validateZipBuffer };

if (require.main === module) {
  main();
}
