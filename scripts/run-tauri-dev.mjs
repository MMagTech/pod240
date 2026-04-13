/**
 * Prepends ~/.cargo/bin to PATH so `cargo` is found when the shell
 * hasn't picked up rustup's PATH change yet (common on Windows).
 * Invokes the Tauri CLI via `node tauri.js` (no shell) to avoid DEP0190.
 */
import { spawn } from "node:child_process";
import { delimiter, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

const cargoBin = join(homedir(), ".cargo", "bin");
const prev = process.env.PATH ?? process.env.Path ?? "";
process.env.PATH = `${cargoBin}${delimiter}${prev}`;
process.env.Path = process.env.PATH;

const child = spawn(process.execPath, [tauriCli, "dev"], {
  stdio: "inherit",
  env: process.env,
  cwd: root,
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
