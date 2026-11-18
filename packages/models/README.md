# @scova/models

Scova 前后端与 Worker 共用的 TypeBox schema、TypeScript DTO 和执行事件定义，兼容浏览器、Bun 与 Node.js。数据库表、迁移和客户端由 `@scova/db` 管理，本包不依赖数据库驱动或 ORM。

源码按契约所属领域组织，统一从 `src/index.ts` 导出：

| 目录或文件                       | 职责                                    |
| -------------------------------- | --------------------------------------- |
| `account/`                       | 登录、账号和头像契约                    |
| `configuration/`                 | 模型供应商和搜索配置                    |
| `task/`                          | 任务、草稿、输出形式、预算和任务反馈    |
| `report/`                        | 报告、成果、字段价值、交付及报告会话    |
| `research/`                      | Run、事件、研究覆盖、来源时间和执行诊断 |
| `common/`                        | 通用 schema、格式与契约校验             |
| `library.ts`、`notifications.ts` | 独立的资料库与通知契约                  |

小型独立领域保留单文件；新增相关契约放入对应目录。包内使用相对导入，消费方通过 `@scova/models` 引用。

## 使用

在消费方工作区添加 `"@scova/models": "workspace:*"`，直接导入 schema 和类型：

```ts
import { LoginInputSchema, parseContract, type LoginInput } from '@scova/models';

const input: LoginInput = parseContract(LoginInputSchema, {
    email: 'reader@example.com',
    password: 'example-password',
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
vp test packages/models/tests/contracts.test.ts
```
