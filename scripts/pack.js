const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
if (!fs.existsSync(dist)) {
  fs.mkdirSync(dist, { recursive: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const zipName = `smoother-zhihu-v${pkg.version}.zip`;
const zipPath = path.join(dist, zipName);

if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

if (process.platform === "win32") {
  const manifestPath = path.join(root, "manifest.json");
  const srcPath = path.join(root, "src");
  const licensePath = path.join(root, "LICENSE");
  const readmePath = path.join(root, "README.md");
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${manifestPath}', '${srcPath}', '${licensePath}', '${readmePath}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" },
  );
} else {
  execSync(`zip -r "${zipPath}" manifest.json src LICENSE README.md`, {
    cwd: root,
    stdio: "inherit",
  });
}

console.log(`打包成功: ${zipPath}`);
