# @scova/execution

Server 与 Worker 共用的内部执行契约、传输编码和队列约定。源码导出，支持 Bun 与 Node.js；不连接数据库、不发送 HTTP 请求，也不启动消费者。

| 入口                            | 用途                                       |
| ------------------------------- | ------------------------------------------ |
| `@scova/execution/protocol`     | 内部执行操作、凭据与候选交付契约、接口路径 |
| `@scova/execution/runs`         | Run 租约、执行仓储契约与错误               |
| `@scova/execution/agent`        | 工具账本、预算和 checkpoint 仓储契约       |
| `@scova/execution/search`       | 搜索协调契约与冷却策略                     |
| `@scova/execution/queue`        | 作业身份与队列名称校验                     |
| `@scova/execution/wire`         | Date、字节、undefined 等内部消息值的编解码 |
| `@scova/execution/tool-failure` | 对外安全的工具错误分类与模型诊断           |

```ts
import { executionPath } from '@scova/execution/protocol';
import { encodeExecutionValue } from '@scova/execution/wire';
```

Server 实现授权和持久化，Worker 通过内部接口调用；研究策略属于 `@scova/agent-core`，公开 HTTP DTO 属于 `@scova/models`，通用辅助函数属于 `@scova/shared`。

在仓库根目录验证：

```sh
vp test packages/execution/tests
vp run @scova/execution#build
```
