import { resolve, relative, isAbsolute } from "node:path";

export function schemaName(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("数据库 schema 名称无效");
  return value;
}
export function backupPath(directory: string, name: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.dump$/.test(name))
    throw new Error("备份名称必须是目录内的 .dump 文件名");
  const path = resolve(directory, name);
  const rel = relative(resolve(directory), path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("备份路径超出指定目录");
  return path;
}
export function databaseSettings(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
    throw new Error("DATABASE_URL 无效");
  const businessSchema = schemaName(url.searchParams.get("schema") ?? "public");
  const sslmode = url.searchParams.get("sslmode") ?? "prefer";
  if (!["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode))
    throw new Error("数据库 sslmode 无效");
  url.searchParams.delete("schema");
  return {
    connectionString: url.toString(),
    businessSchema,
    pgEnv: {
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGSSLMODE: sslmode,
    },
  };
}
export function parseOperation(argv: string[]) {
  const [command, ...rest] = argv;
  if (
    !["migrate", "ready", "backup", "restore", "retention", "delete-account"].includes(
      command ?? "",
    )
  )
    throw new Error(
      "用法：operations migrate|ready|backup|restore|retention|delete-account [--name=backup.dump] [--user-id=UUID] [--apply]",
    );
  const options = new Map<string, string>();
  for (const arg of rest) {
    const match = /^--(name|user-id|role|apply)(?:=(.*))?$/.exec(arg);
    if (!match || options.has(match[1]!)) throw new Error("重复或未知维护选项");
    const [, key, value] = match;
    if (key === "apply" ? value !== undefined : !value) throw new Error("维护选项缺少有效值");
    options.set(key!, value ?? "true");
  }
  const allowed: Record<string, string[]> = {
    migrate: [],
    ready: ["role"],
    backup: ["name"],
    restore: ["name", "apply"],
    retention: ["apply"],
    "delete-account": ["user-id", "apply"],
  };
  for (const key of options.keys())
    if (!allowed[command!]!.includes(key)) throw new Error("此命令不接受该选项");
  if (["backup", "restore"].includes(command!) && !options.has("name"))
    throw new Error("需要 --name");
  if (["backup", "restore"].includes(command!)) backupPath("/backups", options.get("name")!);
  const userId = options.get("user-id");
  if (
    command === "delete-account" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId ?? "")
  )
    throw new Error("需要合法 --user-id");
  const role = options.get("role") ?? "api";
  if (!["api", "worker"].includes(role)) throw new Error("role 必须为 api 或 worker");
  return {
    command: command!,
    name: options.get("name"),
    userId,
    apply: options.has("apply"),
    role,
  };
}
