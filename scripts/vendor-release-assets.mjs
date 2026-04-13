/**
 * Downloads HandBrakeCLI + AtomicParsley into src-tauri/resources/ for self-contained builds.
 * Used by CI before `tauri build`. See scripts/third-party.json for pinned versions.
 */
import { execFileSync, execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HB_DIR = path.join(ROOT, "src-tauri/resources/handbrake");
const AP_DIR = path.join(ROOT, "src-tauri/resources/atomicparsley");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "third-party.json"), "utf8"));
const HB_VER = cfg.handbrakeVersion;
const AP = cfg.atomicParsley;

const HB_WIN_ZIP = `https://github.com/HandBrake/HandBrake/releases/download/${HB_VER}/HandBrakeCLI-${HB_VER}-win-x86_64.zip`;
const HB_MAC_DMG = `https://github.com/HandBrake/HandBrake/releases/download/${HB_VER}/HandBrakeCLI-${HB_VER}.dmg`;
const AP_WIN = `https://github.com/wez/atomicparsley/releases/download/${AP.tag}/${AP.windowsZip}`;
const AP_MAC = `https://github.com/wez/atomicparsley/releases/download/${AP.tag}/${AP.macZip}`;

const KEEP = new Set(["README.txt"]);

function cleanDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (KEEP.has(name)) continue;
    const p = path.join(dir, name);
    fs.rmSync(p, { recursive: true, force: true });
  }
}

async function download(url, destFile) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destFile, buf);
}

function unzipToDir(zipPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("tar", ["-xf", zipPath, "-C", outDir], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", outDir], { stdio: "inherit" });
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Flatten: if single subdir, use its contents as root (common zip layout). */
function flattenExtractedRoot(extractRoot) {
  const entries = fs.readdirSync(extractRoot);
  if (entries.length === 1) {
    const one = path.join(extractRoot, entries[0]);
    if (fs.statSync(one).isDirectory()) return one;
  }
  return extractRoot;
}

async function vendorHandBrakeWindows() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-win-"));
  const zipPath = path.join(tmp, "hb.zip");
  try {
    console.log("Downloading HandBrake CLI (Windows x86_64)…");
    await download(HB_WIN_ZIP, zipPath);
    const extract = path.join(tmp, "out");
    unzipToDir(zipPath, extract);
    const root = flattenExtractedRoot(extract);
    cleanDir(HB_DIR);
    copyTree(root, HB_DIR);
    const exe = path.join(HB_DIR, "HandBrakeCLI.exe");
    if (!fs.existsSync(exe)) throw new Error("HandBrakeCLI.exe missing after extract");
    console.log("HandBrake CLI (Windows) →", HB_DIR);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function vendorHandBrakeMac() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-mac-"));
  const dmgPath = path.join(tmp, "cli.dmg");
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "hb-mnt-"));
  try {
    console.log("Downloading HandBrake CLI (macOS dmg)…");
    await download(HB_MAC_DMG, dmgPath);
    execSync(`hdiutil attach "${dmgPath}" -readonly -nobrowse -mountpoint "${mnt}"`, {
      stdio: "inherit",
    });
    try {
      const out = execSync(`find "${mnt}" -name HandBrakeCLI -type f`, { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean);
      if (out.length === 0) throw new Error("HandBrakeCLI binary not found inside dmg");
      const cliPath = out[0];
      const cliDir = path.dirname(cliPath);
      cleanDir(HB_DIR);
      for (const name of fs.readdirSync(cliDir)) {
        const s = path.join(cliDir, name);
        const d = path.join(HB_DIR, name);
        if (fs.statSync(s).isFile()) fs.copyFileSync(s, d);
      }
      const destCli = path.join(HB_DIR, "HandBrakeCLI");
      fs.chmodSync(destCli, 0o755);
      console.log("HandBrake CLI (macOS) →", HB_DIR);
    } finally {
      execSync(`hdiutil detach "${mnt}" -force`, { stdio: "inherit" });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function findFileRecursive(dir, baseName) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const r = findFileRecursive(p, baseName);
      if (r) return r;
    } else if (ent.name === baseName) return p;
  }
  return null;
}

async function vendorAtomicParsleyWindows() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-win-"));
  const zipPath = path.join(tmp, "ap.zip");
  try {
    console.log("Downloading AtomicParsley (Windows)…");
    await download(AP_WIN, zipPath);
    const extract = path.join(tmp, "out");
    unzipToDir(zipPath, extract);
    const root = flattenExtractedRoot(extract);
    cleanDir(AP_DIR);
    const found = findFileRecursive(root, "AtomicParsley.exe");
    if (!found) throw new Error(`AtomicParsley.exe not found under ${root}`);
    const fromDir = path.dirname(found);
    copyTree(fromDir, AP_DIR);
    if (!fs.existsSync(path.join(AP_DIR, "AtomicParsley.exe"))) {
      throw new Error("AtomicParsley.exe missing after copy");
    }
    console.log("AtomicParsley (Windows) →", AP_DIR);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function vendorAtomicParsleyMac() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ap-mac-"));
  const zipPath = path.join(tmp, "ap.zip");
  try {
    console.log("Downloading AtomicParsley (macOS)…");
    await download(AP_MAC, zipPath);
    const extract = path.join(tmp, "out");
    unzipToDir(zipPath, extract);
    const root = flattenExtractedRoot(extract);
    cleanDir(AP_DIR);
    let bin = findFileRecursive(root, "AtomicParsley") || findFileRecursive(root, "atomicparsley");
    if (!bin) throw new Error("AtomicParsley binary not found in zip");
    const fromDir = path.dirname(bin);
    copyTree(fromDir, AP_DIR);
    const dest = path.join(AP_DIR, path.basename(bin));
    fs.chmodSync(dest, 0o755);
    if (path.basename(dest) !== "AtomicParsley") {
      const canonical = path.join(AP_DIR, "AtomicParsley");
      if (dest !== canonical) fs.renameSync(dest, canonical);
      fs.chmodSync(canonical, 0o755);
    }
    console.log("AtomicParsley (macOS) →", AP_DIR);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform === "win32") {
    await vendorHandBrakeWindows();
    await vendorAtomicParsleyWindows();
  } else if (process.platform === "darwin") {
    await vendorHandBrakeMac();
    await vendorAtomicParsleyMac();
  } else {
    console.error("vendor-release-assets.mjs: unsupported platform", process.platform);
    process.exit(1);
  }
  console.log("Vendor step finished.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
