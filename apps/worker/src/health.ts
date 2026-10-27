import { operations } from "@/handler/operations.ts";
try {
  const role = process.argv[2] ?? "worker";
  if (role === "api") {
    const response = await fetch("http://127.0.0.1:3000/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("API 未响应");
  }
  await operations(["ready", "--role=" + role]);
} catch {
  process.exitCode = 1;
}
