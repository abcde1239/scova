# 后端验证

后端验证覆盖认证 HTTP、PostgreSQL、Redis、Outbox/BullMQ、独立 Worker、Agent checkpoint 与报告交付。供应商 fixture 使用固定搜索、网页与模型响应，验证生产编排和持久化规则；真实搜索、网页及远程模型连接单独验证。

## 环境与命令

安装依赖并启动专用测试服务：

```sh
vp install
# 启动专用测试 PostgreSQL 17 / Redis 7
# 使用 55432 / 56379，不复用生产数据库
docker compose -p scova-runtime-test -f compose.test.yaml up -d
vp run ready
```

`ready` 包含格式、类型、lint、单元测试、工作区构建、Bun/Node 运行时、OpenAPI 漂移、HTTP 进程，以及串行后端集成与验收，并追加[基础浏览器](../reference/browser-testing.md)和[完整工作台](../reference/workbench-verification.md)门禁；后两者另需锁定 Chromium、浏览器系统依赖和 Docker Compose。数据库账号需允许建立临时 schema 和维护测试的独立临时数据库。备份恢复测试还要求 PATH 中有 PostgreSQL 17 或更新版本的 `pg_dump`、`pg_restore`。自定义连接使用 `SCOVA_TEST_DATABASE_URL`、`SCOVA_TEST_REDIS_URL`；运行时检查另读取 `RUNTIME_DATABASE_URL`、`RUNTIME_REDIS_URL`，见测试运行时说明。

共享测试 Redis 的套件必须串行运行。`vp run test:integration` 已负责顺序执行，不同时在其他工作区启动集成测试。

```sh
# 单独运行后端进程与跨功能验收
vp run test:e2e:backend
# 真实单机容器部署、重启与备份恢复；使用独立临时项目
vp run test:deployment
# 真实搜索/阅读；完整研究还需配置模型
vp run test:search:live
vp run test:search:read
```

## 验收范围

- 英语材料、招生公告、研究原文三个固定场景：首次完整基线，第二次重复/新增/变化，第三次来源失败的 partial；通过真实 API 创建 Run，经独立 Worker 交付，检查报告、通知、收件箱、两侧引用与基线。
- 重复命令和终态队列重投不重复交付；双账号不能读取或修改对方资料。
- 报告→收藏/中文笔记检索→有原文引用的问答→明确确认后续研究；反馈冻结、实际深入子查询及撤销后的新执行，原报告和普通比较范围保持各自语义。四种格式使用同一公共 Report 结构交付。
- Task、Run、Report、Inbox 微秒级游标，不重复、不漏项；通知和 Inbox 在并发标已读时保持请求内一致快照。
- 真实 socket 的事件回放、续传和新事件可见性；慢读、关闭及 Bun/Node 差异由专门 SSE 集成套件覆盖。
- 十个真实会话并发读取四类列表。每账号 20 个任务、400 个 Run/Report/Inbox；每接口预热 3 轮，采样 20 轮，每轮 10 并发，完整 HTTP 响应与 JSON 解析 p95 要求低于 500ms。测试输出数据规模、运行时、平台和实测值；这是本机 Node loopback 基准。

上述后端集成用例不证明前端页面或浏览器用户旅程；`ready` 的浏览器任务提供独立证据。固定供应商响应不能证明远程模型或公网网站可用；来源验证码、抓取失败、官方身份未核验等情况仍须如实报告不足。
