import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const bunPath =
  process.env.BUN_BIN ??
  join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
if (!existsSync(bunPath)) throw new Error("设置 BUN_BIN 为独立 Bun 路径后运行兼容性测试");

async function unusedPort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

for (const [runtime, executable, entry] of [
  ["bun", bunPath, "apps/api/src/main.ts"],
  ["node", process.execPath, "apps/api/src/node.ts"],
]) {
  const port = await unusedPort();
  const child = spawn(executable, [entry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  let exit;
  const ended = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve(exit);
    }),
  );
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (exit) throw new Error(`${runtime} 启动失败：${output}`);
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (health.ok) break;
      } catch {
        /* 等待进程监听，而非假定 spawn 后已就绪。 */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(health?.ok, `${runtime} 未按期就绪：${output}`);
    assert.deepEqual(await health.json(), { status: "ok", runtime });
    const spec = await (await fetch(`http://127.0.0.1:${port}/swagger/json`)).json();
    assert.equal(spec.info.title, "知巡 Scova API");
    assert.equal(spec.paths["/health"].get.summary, "健康检查");
    child.send("scova:shutdown");
    const result = await Promise.race([
      ended,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${runtime} 未优雅退出`)), 5000).unref(),
      ),
    ]);
    assert.equal(result.code, 0, `${runtime} 退出失败：${output}`);
    console.log(`${runtime}: HTTP、中文 Swagger 与优雅退出通过`);
  } finally {
    if (!exit) child.kill();
  }
}
