// Produces dist/SignarmSignal.exe — the single-file Windows launcher that
// embeds the Tauri binary plus WebView2Loader.dll.
//
// Pipeline:
//   1. npm run build:static  → regenerates out/ for Tauri
//   2. cargo build (Tauri)   → produces the real SignarmSignal.exe
//   3. copy payload into launcher/payload/
//   4. cargo build (launcher) → produces the single-file wrapper
//   5. copy to dist/
//
// Requires the x86_64-pc-windows-gnu Rust target and the
// x86_64-w64-mingw32 cross toolchain when run from a non-Windows host.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const target = process.env.SIGNAL_WIN_TARGET ?? "x86_64-pc-windows-gnu";
const run = (cmd, cwd = root) =>
  execSync(cmd, { stdio: "inherit", cwd, env: process.env });

console.log(`\n[1/5] building static frontend`);
run("node scripts/build-static.mjs");

console.log(`\n[2/5] building Tauri binary for ${target}`);
run(`cargo build --release --target ${target}`, join(root, "src-tauri"));

const tauriOut = join(root, "src-tauri/target", target, "release");
const appExe = join(tauriOut, "SignarmSignal.exe");
const dll = join(tauriOut, "WebView2Loader.dll");
if (!existsSync(appExe)) throw new Error(`missing ${appExe}`);
if (!existsSync(dll)) throw new Error(`missing ${dll}`);

console.log(`\n[3/5] staging payload for launcher`);
const payload = join(root, "launcher/payload");
mkdirSync(payload, { recursive: true });
cpSync(appExe, join(payload, "SignarmSignal.exe"));
cpSync(dll, join(payload, "WebView2Loader.dll"));

console.log(`\n[4/5] building launcher for ${target}`);
run(`cargo build --release --target ${target}`, join(root, "launcher"));

console.log(`\n[5/5] copying to dist/`);
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const finalExe = join(dist, "SignarmSignal.exe");
cpSync(join(root, "launcher/target", target, "release/SignarmSignal.exe"), finalExe);

console.log(`\ndone → ${finalExe}`);
