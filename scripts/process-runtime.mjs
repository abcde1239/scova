import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 使用项目安装的官方 vpx CLI，其本地入口会双向转发父子 IPC。 */
export function nodeScriptCommand(script, args = []) {
  const manifest = fileURLToPath(import.meta.resolve("vite-plus/package.json"));
  const vpx = join(dirname(manifest), "bin", "vpx");
  return { executable: process.execPath, args: [vpx, script, ...args] };
}
