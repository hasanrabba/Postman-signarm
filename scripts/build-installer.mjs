// Produces dist/SignarmSignal-Setup.exe — a proper Windows installer that
// drops Signarm Signal into %ProgramFiles%\Signarm Signal\, creates Start
// menu and optional desktop shortcuts, and registers with Add/Remove
// Programs so users can uninstall it from Settings.
//
// Pipeline:
//   1. Ensure the single-file launcher exists (calls build-launcher.mjs).
//   2. Stage SignarmSignal.exe + icon.ico into installer/staging/.
//   3. Run makensis to produce SignarmSignal-Setup.exe.
//   4. Copy the installer into dist/.
//
// Requires NSIS (`apt install nsis` on Debian/Ubuntu, choco install nsis on
// Windows).

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: "inherit", cwd: root, env: process.env, ...opts });

// Always rebuild the launcher. Cargo caches so this is fast when the
// source hasn't changed, but we get a guaranteed-fresh artifact when it
// has. Pass --skip-launcher to reuse an existing dist/SignarmSignal.exe
// when debugging the installer in isolation.
const launcherExe = join(root, "dist/SignarmSignal.exe");
if (process.argv.includes("--skip-launcher") && existsSync(launcherExe)) {
  console.log("[installer] --skip-launcher: reusing existing launcher");
} else {
  run("node scripts/build-launcher.mjs");
}
if (!existsSync(launcherExe)) {
  throw new Error(`launcher missing at ${launcherExe}`);
}

const staging = join(root, "installer/staging");
if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

cpSync(launcherExe, join(staging, "SignarmSignal.exe"));
cpSync(join(root, "src-tauri/icons/icon.ico"), join(staging, "icon.ico"));

// The installer version must not drift from the launcher's: the uninstaller
// cleans %LOCALAPPDATA%\SignarmSignal, and the ARP entry claims this version.
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const launcherToml = readFileSync(join(root, "launcher/Cargo.toml"), "utf8");
const launcherVersion = /^version\s*=\s*"([^"]+)"/m.exec(launcherToml)?.[1];
if (launcherVersion !== version) {
  throw new Error(
    `version mismatch: package.json is ${version} but launcher/Cargo.toml is ${launcherVersion}. ` +
    `They must match — the launcher stamps its cache directory with its own version.`
  );
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`version "${version}" must be MAJOR.MINOR.PATCH for VIProductVersion`);
}
console.log(`[installer] building version ${version}`);

// makensis emits its output into the script's directory; run with that cwd.
run(
  `makensis -V2 -DAPPVERSION=${version} -DAPPVERSION4=${version}.0 signarm-signal.nsi`,
  { cwd: join(root, "installer") }
);

const produced = join(root, "installer/SignarmSignal-Setup.exe");
if (!existsSync(produced)) {
  throw new Error(`makensis did not produce ${produced}`);
}
const final = join(root, "dist/SignarmSignal-Setup.exe");
renameSync(produced, final);

console.log(`\ndone → ${final}`);
