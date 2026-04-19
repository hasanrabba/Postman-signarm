// Produces a Next.js static export for the Tauri desktop build. Next's
// output: "export" rejects API routes, so we stash them aside while the
// build runs and restore them afterward.
import { execSync } from "node:child_process";
import { renameSync, existsSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const apiDir = join(root, "src/app/api");
const stash = join(root, ".api.stash");

let stashed = false;
try {
  if (existsSync(apiDir)) {
    if (existsSync(stash)) rmSync(stash, { recursive: true, force: true });
    cpSync(apiDir, stash, { recursive: true });
    rmSync(apiDir, { recursive: true, force: true });
    stashed = true;
    console.log("[build-static] stashed src/app/api");
  }
  execSync("npx next build", {
    stdio: "inherit",
    env: { ...process.env, SIGNAL_TARGET: "tauri" },
  });
} finally {
  if (stashed) {
    if (existsSync(apiDir)) rmSync(apiDir, { recursive: true, force: true });
    renameSync(stash, apiDir);
    console.log("[build-static] restored src/app/api");
  }
}
