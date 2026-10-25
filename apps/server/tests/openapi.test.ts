import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { createApiApp, HealthResponseSchema } from "../src/app/index.ts";
import { generateOpenApi, validateOpenApi } from "../../../scripts/generate-openapi.mjs";
import { nodeScriptCommand } from "../../../scripts/process-runtime.mjs";

type Schema = {
  $ref?: string;
  description?: string;
  properties?: Record<string, Schema>;
};
type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
};
type Document = {
  info: { title: string; version?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
};

function healthSchema(document: Document): Schema {
  const response = document.paths["/health"].get.responses["200"];
  let schema = response.content?.["application/json"]?.schema;
  expect(schema, "健康响应必须声明 JSON schema").toBeDefined();
  if (schema?.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    schema = document.components?.schemas?.[name];
  }
  expect(schema?.properties, "健康响应不能只依赖 handler 推断字段").toBeDefined();
  return schema!;
}

describe("中文 OpenAPI 生成与校验", () => {
  it("通过实际 Elysia 路由提供健康检查、Swagger UI 和 JSON", async () => {
    const app = createApiApp("node");
    const health = await app.handle(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    const ui = await app.handle(new Request("http://localhost/swagger"));
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(await ui.text()).toMatch(/swagger|scalar/i);

    const response = await app.handle(new Request("http://localhost/swagger/json"));
    expect(response.status).toBe(200);
    const document = (await response.json()) as Document;
    expect(document.info.title).toBe("知巡 Scova API");
    expect(document.paths["/health"].get).toMatchObject({
      summary: "健康检查",
      tags: ["系统"],
    });
    for (const route of app.routes.filter(({ path }) => !path.startsWith("/swagger"))) {
      const path = route.path.replace(/:([^/]+)/g, "{$1}");
      expect(
        document.paths[path]?.[route.method.toLowerCase()],
        `${route.method} ${path}`,
      ).toBeDefined();
    }
    expect(() => validateOpenApi(document)).not.toThrow();
  });

  it("从同一应用生成稳定文档并与提交产物一致", async () => {
    const first = await generateOpenApi();
    const second = await generateOpenApi();
    expect(first).toEqual(second);
    const committed = JSON.parse(
      await readFile(new URL("../../../swagger.json", import.meta.url), "utf8"),
    );
    expect(first).toEqual(committed);
  });

  it("健康响应字段有中文说明且 schema 描述与真实响应相符", async () => {
    const document = (await generateOpenApi()) as Document;
    const schema = healthSchema(document);
    expect(schema.properties?.status?.description).toMatch(/[\u3400-\u9fff]/);
    expect(schema.properties?.runtime?.description).toMatch(/[\u3400-\u9fff]/);
    expect(schema).toMatchObject(JSON.parse(JSON.stringify(HealthResponseSchema)));
    const response = await createApiApp("node").handle(new Request("http://localhost/health"));
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(schema.properties!).sort());
  });

  it("拒绝缺少中文的 operation 描述", async () => {
    const document = structuredClone((await generateOpenApi()) as Document);
    document.paths["/health"].get.summary = "Health check";
    expect(() => validateOpenApi(document)).toThrow(/中文|summary/);
  });

  it("拒绝缺少中文说明的 DTO 字段", async () => {
    const document = structuredClone((await generateOpenApi()) as Document);
    healthSchema(document).properties!.status.description = "";
    expect(() => validateOpenApi(document)).toThrow(/中文|description|status/);
  });

  it("拒绝不能解析的 schema 引用", async () => {
    const document = structuredClone((await generateOpenApi()) as Document);
    const content = document.paths["/health"].get.responses["200"].content!;
    content["application/json"].schema = { $ref: "#/components/schemas/MissingContract" };
    expect(() => validateOpenApi(document)).toThrow(/ref|引用|MissingContract/);
  });

  it("拒绝重复的 operationId", async () => {
    const document = structuredClone((await generateOpenApi()) as Document);
    const original = document.paths["/health"].get;
    expect(original.operationId).toBeTruthy();
    document.paths["/openapi-test-only"] = { get: structuredClone(original) };
    expect(() => validateOpenApi(document)).toThrow(/operationId|重复/);
  });

  it("检查模式拒绝过期文档并保留原文件", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "scova-openapi-"));
    try {
      const stale = structuredClone((await generateOpenApi()) as Document);
      stale.info.version = "stale-test-version";
      const target = join(temporary, "openapi.json");
      const original = JSON.stringify(stale, null, 2) + "\n";
      await writeFile(target, original, "utf8");
      const command = fileURLToPath(
        new URL("../../../scripts/generate-openapi.mjs", import.meta.url),
      );
      const execute = promisify(execFile);
      const invocation = nodeScriptCommand(command, ["--output", target, "--check"]);
      await expect(
        execute(invocation.executable, invocation.args, { windowsHide: true }),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(target, "utf8")).toBe(original);
    } finally {
      // 删除边界只允许本测试在系统临时目录中新建的唯一子目录。
      expect(dirname(resolve(temporary))).toBe(resolve(tmpdir()));
      expect(basename(temporary)).toMatch(/^scova-openapi-/);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
