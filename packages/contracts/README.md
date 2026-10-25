# @scova/contracts

Scova 前后端与 Worker 共用的 TypeBox schema、TypeScript DTO 和执行事件定义，兼容 Bun 与 Node.js。

## 使用

在消费方工作区添加 `"@scova/contracts": "workspace:*"`，直接导入 schema 和类型：

```ts
import { LoginInputSchema, parseContract, type LoginInput } from "@scova/contracts";

const input: LoginInput = parseContract(LoginInputSchema, {
  email: "reader@example.com",
  password: "example-password",
});
```

Elysia 路由直接使用同一份 schema 声明请求与响应；中文字段说明用于生成 OpenAPI。

## 接口约定

- 成功响应为普通 JSON；列表使用 `{ items, nextCursor }`。
- 错误使用 `{ code, message, requestId, fieldErrors? }`。
- 任务编辑使用 `ETag` / `If-Match`，写命令使用 `Idempotency-Key`。
- 执行事件带版本与递增序号，支持 SSE 回放契约。

字段校验、事件结构和 SSE 控制帧详见[契约参考](../../docs/public/reference/contracts.md)。

## 验证

在仓库根目录运行：

```sh
vp test packages/contracts/tests/contracts.test.ts
```
