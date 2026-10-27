import { operations } from "@/handler/operations.ts";

try {
  console.log(JSON.stringify(await operations()));
} catch {
  console.error("后端维护失败；请检查命令、维护窗口、依赖与备份文件。未输出连接地址或供应商信息。");
  process.exitCode = 1;
}
