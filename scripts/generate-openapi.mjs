import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiApp, contractModels } from "../apps/server/src/app/index.ts";

const chinese = /[\u3400-\u9fff]/u;
const verbs = new Set(["get", "put", "post", "delete", "patch", "head", "options", "trace"]);

/** 校验生成文档的中文说明、引用、唯一操作标识和真实路由契约。 */
export function validateOpenApi(spec) {
  if (!spec?.openapi?.startsWith("3.") || !spec.paths)
    throw new Error("缺少 OpenAPI 3 文档或 paths");
  const ids = new Set();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [verb, operation] of Object.entries(item)) {
      if (!verbs.has(verb)) continue;
      if (!chinese.test(operation.summary ?? "") || !chinese.test(operation.description ?? "")) {
        throw new Error(`${verb} ${path} 缺少中文 summary/description`);
      }
      if (!operation.tags?.length || !operation.tags.every((tag) => chinese.test(tag)))
        throw new Error(`${verb} ${path} 缺少中文 tags`);
      if (!operation.operationId || ids.has(operation.operationId))
        throw new Error(`operationId 缺失或重复：${path}`);
      ids.add(operation.operationId);
      if (!operation.responses || !Object.keys(operation.responses).length)
        throw new Error(`${path} 未声明响应`);
    }
  }
  const walk = (value, path = "$") => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      if (!value.$ref.startsWith("#/")) throw new Error(`不支持文档外部引用：${value.$ref}`);
      let target = spec;
      for (const key of value.$ref.slice(2).split("/"))
        target = target?.[key.replaceAll("~1", "/").replaceAll("~0", "~")];
      if (!target) throw new Error(`无法解析 $ref：${value.$ref}`);
    }
    if (value.properties) {
      for (const [name, property] of Object.entries(value.properties)) {
        if (!chinese.test(property.description ?? ""))
          throw new Error(`${path}.${name} 缺少中文字段 description`);
      }
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(spec);
  return spec;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
export async function generateOpenApi() {
  const response = await createApiApp().handle(new Request("http://localhost/swagger/json"));
  if (!response.ok) throw new Error(`生成 OpenAPI 失败：HTTP ${response.status}`);
  const spec = await response.json();
  // 文档模型由运行时 schema 产生；不能为生成文档手写另一套 DTO。
  for (const [name, schema] of Object.entries(contractModels)) {
    if (!spec.components?.schemas?.[name]) throw new Error(`缺少共享模型：${name}`);
    const documented = JSON.stringify(stable(spec.components.schemas[name]));
    const source = JSON.stringify(stable(JSON.parse(JSON.stringify(schema))));
    if (documented !== source) throw new Error(`文档模型与 contracts 不一致：${name}`);
  }
  return stable(validateOpenApi(spec));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const outputArg = process.argv.indexOf("--output");
    const output =
      outputArg >= 0
        ? resolve(process.argv[outputArg + 1])
        : fileURLToPath(new URL("../apps/server/openapi.json", import.meta.url));
    const expected = `${JSON.stringify(await generateOpenApi(), null, 2)}\n`;
    if (process.argv.includes("--check")) {
      if (
        JSON.stringify(stable(JSON.parse(await readFile(output, "utf8")))) !==
        JSON.stringify(stable(JSON.parse(expected)))
      )
        throw new Error("OpenAPI 产物已漂移，请运行 vp run api:openapi 后提交更新");
      console.log("中文 OpenAPI 与运行时契约一致");
    } else {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, expected);
      console.log(`已生成中文 OpenAPI：${output}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
