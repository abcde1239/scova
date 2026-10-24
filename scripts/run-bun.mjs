import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const candidate = join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
const executable = process.env.BUN_BIN ?? (existsSync(candidate) ? candidate : "bun");
const result = spawnSync(executable, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
