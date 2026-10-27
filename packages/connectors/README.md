# @scova/connectors

Scova 的搜索、远程模型与安全网页阅读适配器。默认搜索为自部署 SearxNG，无需商业搜索 API 密钥；Tavily 仅在显式选择时启用。[本机部署与配置](../../docs/public/guides/search.md)。

搜索与阅读可以独立于模型使用：

```ts
import { createSearxngSearch, createPageReader } from '@scova/connectors';

const search = createSearxngSearch({ baseUrl: 'http://127.0.0.1:8080' });
const results = await search.search('IANA example domains', {
    signal: AbortSignal.timeout(15_000),
});
const first = results.results[0];
if (first) {
    const page = await createPageReader().read(first.originalUrl);
    console.log(page.text, page.contentHash);
}
```

搜索结果是 `search_snippet`，保留原始/规范 URL 和引擎归因；`coverage` 记录上游失败、过滤与截断。只有阅读器实际提取的正文返回 `read_page`、采集时间、指纹、提取版本及实际 `fetchedUrl`。正文标记为不可信数据，不执行脚本或加载页面资源。指纹只覆盖返回的 `text`；`truncated` 表示覆盖不完整，不能据此前缀判断整页未变化。

阅读器仅允许 HTTP/HTTPS 默认端口与公共 IP，拒绝混合公私 DNS，将已验证地址绑定实际连接，每跳重验（最多 3 跳）。内部 SearxNG 使用独立固定端点通道，仅允许该实例的 `/search` JSON 请求，禁止重定向，不向阅读器开放私网权限。所有调用最多 15 秒、下载最多 2 MiB，阅读器另限制正文长度和 DOM 数量。

供应商最多尝试 3 次，仅重试临时网络、429 和 5xx；`beforeAttempt(kind)` 每次尝试前执行，供调用方预留预算并拒绝后续请求。Run 累计预算、工具账本、证据授权由消费方负责。

远程模型可以独立创建，也可与搜索一起装配：

```ts
import { createConnectorBundle } from '@scova/connectors';

const connectors = createConnectorBundle({
    searxngBaseUrl: process.env.SEARXNG_BASE_URL, // 默认本机 :8080
    modelApiKey: process.env.MODEL_API_KEY,
    model: process.env.MODEL_NAME,
    modelBaseUrl: process.env.MODEL_BASE_URL, // 默认 https://api.openai.com/v1
});
```

`generateStructured` 接收 JSON Schema、输入/输出 token 上限与独立 `untrustedSources`，校验输出和 usage；缺 usage 时保守估算。模型地址仅允许 HTTPS。密钥只由部署者传入，不输出日志。完整 bundle 缺必要配置时固定为明确带原因的全 `demo`；独立 `createSearxngSearch()` 仍可真实搜索。已选 `live` 的任何调用失败均不切换演示或其他供应商。显式设置 `searchProvider: "tavily"` 并传入 `tavilyApiKey` 才调用 Tavily。

仓库根目录验证：

```sh
vp test packages/connectors/tests/connectors.test.ts packages/connectors/tests/searxng.test.ts
vp run test:connectors:runtime # Node/Bun 本地连接与提取，无外部查询
vp run test:search:live        # 真实 SearxNG，无需模型
vp run test:search:read        # 真实搜索及正文读取
vp run test:connectors:live    # SearxNG + 阅读 + 远程模型，有模型费用
vp run test:connectors:tavily  # 显式 Tavily + 阅读 + 模型，有外部费用
```

真实烟测仅发送固定公开查询，搜索、读取、模型各最多尝试一次。模型输出最多 256 token，引用必须确实存在于采集正文；缺凭据输出 `NOT RUN`，不算真实通过。普通测试使用固定响应与本地 socket，不消耗真实密钥。
