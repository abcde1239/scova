import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (
  !args.length ||
  !["migrate", "backup", "restore", "retention", "delete-account"].includes(args[0])
)
  throw new Error(
    "用法：vp run operations migrate|backup|restore|retention|delete-account [选项]；命令会停止 API/Worker/代理，完成后手动重新启动。",
  );
function compose(options) {
  const result = spawnSync("docker", ["compose", "--profile", "maintenance", ...options], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Compose 维护操作失败，应用保持停止");
}
compose(["stop", "proxy", "api", "worker"]);
compose(["run", "--rm", "operations", ...args]);
console.log("维护完成；运行 docker compose up -d 恢复服务。");
