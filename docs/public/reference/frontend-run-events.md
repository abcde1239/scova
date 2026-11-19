# Web Run 事件订阅

`subscribeRunEvents` 在统一 API 模块中通过当前会话 requestlane Fetch transport 的 `native` 入口读取持久 SSE。页面使用 `useRunEvents`，不再创建 fetch、EventSource 或另一层网络客户端。

```ts
import { computed } from 'vue';
import { useRunEvents } from '@/composable/useRunEvents';

const subscription = useRunEvents(() => props.runId, {
    onEvent(event) {
        // 可选：更新短暂的执行提示。持久业务数据仍从 Query 读取。
        console.debug(event.type);
    },
});
const connection = computed(() => subscription.value?.state.value ?? 'closed');
const connectionError = computed(() => subscription.value?.error.value);
```

必须在安装会话生命周期的组件 setup 或 Vue effect scope 中调用。空 Run ID、未登录时不建立流；参数、会话 epoch 变化或作用域释放时清理旧订阅。手工订阅通过 `stop()` 取消，`done` 在完成、取消或错误后结束；错误通过 `error` 读取，不以 rejected Promise 传给页面。

## 状态与恢复

- `connecting`、`open`、`reconnecting` 表示连接状态；不能据此推断执行失败。
- `closed` 表示主动取消、作用域结束或账号切换；当前流的 401 清理会话，403 停止但不退出。
- `complete` 表示 EOF 后读取的权威 Run 已为 succeeded、partial、failed 或 canceled。连接完成可以对应失败的 Run，页面须分别展示。
- `error` 表示协议错误、回调错误或恢复预算耗尽。预算耗尽保留最后一次错误的 HTTP 状态、业务码和 requestId，不能把它写成 Run 失败。

默认响应头超时 15 秒，读取空闲超时 45 秒；服务端心跳会刷新空闲计时。最多重连 6 次（含 reset 与非终态 EOF），初始连接之外共不超过 7 次流请求；退避从 500 毫秒指数增长，上限 8 秒。业务可通过 options 调整有限预算。取消也中止退避和 EOF 后的快照请求。清理会触发 abort/cancel 并释放 reader，不等待不合作 transport 的 cancel Promise。

只处理 seq 大于已接受游标的事件，回调成功后才推进 seq 和 Last-Event-ID。重连同时发送合法的 `after` 与最后接受的事件 ID。`stream.reset` 替换权威快照、采用 resumeAfter、清除旧事件 ID，然后关闭旧流重连；每次重连创建新解析器。完整有效帧后接坏帧时，先交付有效帧。格式错误停止恢复，EOF 的截断尾帧可从最后成功游标恢复。

回调可以同步或返回 Promise，按事件顺序等待。回调抛错或拒绝时停止订阅，避免重连后重复执行相同副作用；取消会结束等待，但不能撤销回调自行发起的外部操作。回调应仅做短暂展示更新并及时结束，业务写操作仍走独立命令。

## Query 契约

`runQueryOptions(lifecycle, runId)` 为权威 GET Run 提供稳定的参数化端点与 Query key，并校验返回 Run.id 与目标一致；`requestRun(scope, runId, signal?)` 可用于已捕获会话的单次读取。不要按请求创建 endpoint identity 或自建无限增长的 endpoint Map。

Query key 由当前 scope 的 `queryKey` 加前缀组成：`['session', accountId, epoch, ...domainKey]`。Run 单项使用 `['run', runId, endpointIdentity, { params: { runId } }]`；页面列表约定第一项为 `runs`、`tasks`、`reports`、`notifications` 或 `inbox`。接受事件/reset 后失效当前账号和 epoch 的这些域，拒绝旧账号事件、迟到响应或回调污染新缓存。reset 和终态 EOF 将完整 Run 快照装入同一单项缓存。

```sh
vp test apps/web/tests/run-events.test.ts
```

该测试使用可控流覆盖续传、去重、reset、超时、有限恢复、HTTP/协议错误、回调、取消和 Vue 作用域。浏览器流样本只能证明浏览器执行路径；真实 API SSE 需要独立后端与数据库环境验证，不能由手造帧代替。

可选 `onReset(snapshot)` 在历史游标过期时、替换快照前通知消费者，用于清空旧日志与临时报告线索；其取消/异常处理与其他回调一致。不要把过期前后的事件拼成完整历史。
