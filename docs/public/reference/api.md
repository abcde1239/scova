# 中文接口文档

API 使用 Bun + Elysia；Node.js 通过官方适配器兼容。启动后访问 `/swagger` 查看交互文档，`/swagger/json` 获取 OpenAPI 3.1 JSON。

```sh
vp run server#start
# Node.js 兼容入口
vp run server#start:node
# 从真实 Elysia 路由生成中文接口文档
vp run api:openapi
# 检查已提交产物是否漂移
vp run api:openapi:check
```

根目录的 [swagger.json](../../../swagger.json) 是生成的 OpenAPI 3.1 文档，不手工编辑。请求和响应引用 `packages/contracts` 的运行时 schema；路由使用中文 summary、description、tags 和唯一 operationId，DTO 字段均有中文说明。新增接口必须同时声明请求、成功/失败响应及必要的 Cookie、CSRF、幂等和修订版本头。

生成器校验中文说明、模型与 contracts 等价、引用可解析和 operationId 唯一。GitHub Actions 运行生成漂移检查、文档测试和 Bun/Node HTTP 启停测试；它不代替真实数据库与队列的业务集成测试。
