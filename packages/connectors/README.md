# @scova/connectors

Scova 的搜索、远程模型与安全网页阅读适配器。默认使用自部署 SearxNG；支持显式配置 DeepSeek Search / Fetch、Tavily Search / Extract、自定义 HTTP JSON 搜索，以及授权的 OpenAI Responses/Anthropic 内置搜索。DeepSeek/Tavily 的搜索与网页读取均由服务商提供；自定义 JSON 搜索明确配合本地 Reader。Perplexity Search 保留搜索适配兼容，但缺少独立读取接口，不可用于 API 模式管线。[配置与计费边界](../../docs/public/guides/search.md)。

源码按职责组织，`src/index.ts` 统一导出，`src/types.ts` 保存公共契约，`src/pipeline.ts` 装配连接器：

| 目录                 | 职责                                               |
| -------------------- | -------------------------------------------------- |
| `http/`              | 安全地址与 DNS、固定 IP 传输、期限和供应商调用重试 |
| `model/`             | 结构化生成、协议转换、诊断、模型目录和余额查询     |
| `search/`            | SearxNG、搜索 API、模型内置搜索、Tavily 和结果排序 |
| `reader/`            | HTTP/浏览器阅读入口、采集快照、诊断及来源时间      |
| `reader/browser/`    | 浏览器渲染、资源路由与限制                         |
| `reader/extraction/` | 正文提取、质量/就绪判定与隔离提取进程              |
| `reader/runtime/`    | Bun 到 Node 的 Reader 委托、宿主和私有行协议       |

包内使用相对导入，消费方通过 `@scova/connectors` 使用；子进程入口随实现保存，不属于公开 API。

搜索可传 `search(query, { language: 'ja' })`。`SearchOptions` 接受有限的 ISO 语言代码，SearXNG/Tavily 透传语言，Perplexity 映射语言过滤；DeepSeek 通过查询文本语言检索，不发送未支持的参数。调用方负责生成对应语言的查询，连接器不执行翻译。

`createSearchApi({ protocol, apiKey, baseUrl? })` 接入独立服务；`createModelSearch({ protocol, apiKey, model, baseUrl })` 是独立模型搜索适配器，通过 `tokenReservation` 与返回的 `usage` 供调用方预留、结算。`createConnectorBundle` 的搜索由 `searchProvider` 选择，不再接受 `modelSearch` 自动替换；生产执行使用账号搜索配置。调用方必须在 `beforeAttempt` 中先持久预留预算；候选不能直接充当正文证据。

搜索与阅读可以独立于模型使用：

```ts
import { createSearxngSearch, createPageReader } from '@scova/connectors';

const search = createSearxngSearch({ baseUrl: 'http://127.0.0.1:8080' });
const results = await search.search('IANA example domains', {
    signal: AbortSignal.timeout(15_000),
});
const first = results.results[0];
if (first) {
    const reader = createPageReader();
    try {
        const page = await reader.read(first.originalUrl);
        console.log(page.text, page.contentHash);
    } finally {
        await reader.close?.();
    }
}
```

搜索结果是 `search_snippet`，保留原始/规范 URL 和引擎归因；`coverage` 记录上游失败、过滤与截断。只有阅读器实际提取的正文返回 `read_page`、采集时间、指纹、提取版本及实际 `fetchedUrl`。正文标记为不可信数据；脚本只用于生成 DOM，不视为 Agent 已完成执行。已识别的验证、登录和加载壳不作为正文。`text` 保留段落、代码换行与缩进、列表及表格行列分隔，指纹与引用位置均基于这份保存文本；提取策略变化使用新版本，不改写旧快照。`truncated` 只表示保存文本的长度裁剪，`collection` 另记录资源、渲染、受限预览和待交互内容。`content_restricted` 表示仅取得公开摘要或订阅预览，`interaction_required` 表示仍有分页或待交互正文，`visual_structure` 表示已保留图示文字，但未完整还原图形连接和空间关系；这些均为部分采集。`collection.complete=false` 的正文可核验引用，但不能证明整页没有变化；完整标记也不证明已跨页或遍历整个站点，历史输出缺少该字段不代表取得新的完整性证明。

SearxNG 在最多 30 条候选中按查询相关性排序后截取返回条目；相关性分数不证明来源可靠。内部客户端的 `engines` 仅接受部署白名单的去重子集，查询中的引擎切换语法会被移除。Worker 的共享搜索包装层负责 Redis 节流、冷却与缓存；`managedSearch` 装配关闭内层自动重试，由包装层逐次申请资格并记账。独立连接器不自建 Redis 连接。

默认阅读器先从安全下载的主 HTML 提取可用正文，正文尚未生成或主区动态数据未就绪时使用 Crawlee `PlaywrightCrawler` 驱动一次性 Chromium 上下文；费用等绑定字段仍显示加载失败时保留部分采集标记。主区内有实质说明的步骤导航会保留，普通菜单会清理。同步提取在可终止的 Node 子进程内运行，使用 Readability 轻量 DOM 保留长文；纯 ruby 注音结构可在有界、保真归一化后执行原结构节点上限。浏览器资源在有界窗口内加载，已有正文不会因可选资源超限被丢弃，受限状态随工具账本保存。所有脚本/JSON/CSS 请求重新经过同一安全 HTTP 客户端。页面不能发起写请求、iframe/图片/下载、WebSocket、service worker 或二次导航；不转发 Cookie、Authorization 和 Set-Cookie。阅读器仅允许 HTTP/HTTPS 默认端口与公共 IP，拒绝混合公私 DNS，将已验证地址绑定实际连接，每跳重验，公开 GET 最多尝试三个已校验地址。单地址连接计时从实际出站开始，响应头到达后正文继续受原总期限约束；排队也计入总期限。所有调用共享最多 15 秒 deadline，主 HTML/单资源最多 2 MiB、总资源最多 8 MiB、最多 32 次请求（含主文档），正文和 DOM 另有限制。

`createConnectorBundle` 可在 SearXNG 路径设置 `firecrawlApiKey`，通过 Firecrawl Cloud Scrape 读取选中页面的 Markdown。Worker 从 `READER_FIRECRAWL_API_KEY` 读取配置，空值使用本地 Reader。账号 DeepSeek/Tavily 和自定义 JSON 搜索保持各自的读取方式。

Worker 使用 Bun 时，完整 Reader 由 Node 子进程通过仓库 Vite+ loader 执行，Bun 仅通过受控行协议转发 HTTP、预算和取消，避免 Windows/Bun 的 Playwright WebSocket 兼容问题。`scripts/run-bun.mjs` 自动传入 Node 路径；独立启动 Bun 时可设置 `READER_NODE_EXECUTABLE`，默认查找 `node`。容器 `worker-runtime` 镜像预装 Chromium，设置 `PLAYWRIGHT_BROWSERS_PATH`。本地可用 `vp exec playwright install chromium` 安装浏览器；Linux 容器默认关闭 Chromium sandbox，依靠非 root、只读根文件系统、cap drop 和 no-new-privileges，宿主机默认启用 Chromium sandbox。

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

`createModelProvider({ protocol, ... })` 和 bundle 的 `modelProtocol` 支持 `openai_chat_completions`（默认严格 JSON Schema）、`openai_json`（JSON 模式）、`anthropic_messages` 与 `gemini`。`generateStructured` 接收 JSON Schema、输入/输出 token 上限与独立 `untrustedSources`，所有协议均校验输出和 usage；缺 usage 时保守估算。模型地址仅允许 HTTPS。密钥由 Server/Worker 从账号加密配置或部署默认值传入，不输出日志。完整 bundle 缺必要配置时固定为明确带原因的全 `demo`；独立 `createSearxngSearch()` 仍可真实搜索。已选 `live` 的任何调用失败均不切换演示或其他供应商。显式设置 `searchProvider: "tavily"` 并传入 `tavilyApiKey` 才调用 Tavily。

结构失败通过 `ConnectorError.modelDiagnostic` 返回 schema SHA-256 指纹、失败类别与最多 6 条预期约束；枚举、数量限制和必填字段只从可信 schema 提取，literal union 的重复分支合并。诊断不含响应值、AJV 原始消息或无效输出正文；已确认的失败调用 usage 独立保留，供调用方结算。

`listProviderModels({ baseUrl, protocol, apiKey, signal })` 仅查询模型目录，返回 `items` 与 `truncated`，不生成内容或验证研究能力。支持上述协议，Gemini 过滤非 `generateContent` 模型；最多五页、1000项、每页1 MiB，总超时12秒。复用公网DNS固定连接保护，凭据请求不重定向、不自动重试。

`readProviderBalance({ baseUrl, apiKey, template?, signal })` 读取余额或额度，默认识别 DeepSeek、OpenRouter、SiliconFlow 官方接口；`new_api` 与 `sub2api` 模板用于对应中转站。结果区分账号和 Key 范围，保留币种；New API 返回原始额度点，不猜测站点汇率。只访问同源固定 GET 接口，总超时12秒、响应最多64 KiB，不扫描、不重定向或重试，未知和缺失值不记为零。该查询不生成内容，也不代表后续模型调用可用。

模型目录和生成默认使用`createModelHttpClient`：系统解析全部为Fake-IP时，通过固定IP的AliDNS HTTPS查询重新解析，再校验并固定真实公网地址；不会放行Fake-IP或混合公私结果。`MODEL_DNS_RESOLVER`默认`auto`，可选`system`（不回退）或显式`alidns/cloudflare/google`。解析不发送密钥，DNS服务本身保TLS验证；通用网页/搜索客户端不启用模型回退。IP固定传输显式使用原URL的Host，兼容Bun的证书域名校验并拒绝调用方覆盖。

仓库根目录验证：

```sh
vp test packages/connectors/tests/connectors.test.ts packages/connectors/tests/searxng.test.ts
vp run test:connectors:runtime # Node/Bun 本地连接与提取，无外部查询
vp run test:reader:browser     # 原生/Node 宿主真实 Chromium，受控 HTTP
vp run test:reader:runtime     # Node/Bun 默认 Reader、预算拒绝与取消
vp run test:search:live        # 真实 SearxNG，无需模型
vp run test:search:read        # 真实搜索及正文读取
vp run test:connectors:live    # SearxNG + 阅读 + 远程模型，有模型费用
vp run test:connectors:tavily  # 显式 Tavily + 阅读 + 模型，有外部费用
```

真实烟测仅发送固定公开查询，搜索、读取、模型各最多尝试一次。模型输出最多 256 token，引用必须确实存在于采集正文；缺凭据输出 `NOT RUN`，不算真实通过。普通测试使用固定响应与本地 socket，不消耗真实密钥。

网页读取通过独立 `READER_DNS_RESOLVER=auto` 兼容全Fake-IP解析：先使用系统解析，仅当全部答案为Fake-IP时，经 Cloudflare 官方公网引导地址连接其 HTTPS DNS，保留原服务域名的 TLS 校验。可显式选择 `system|alidns|cloudflare|google`，不继承 `MODEL_DNS_RESOLVER`，模型默认回退仍为 AliDNS；固定公网IP、逐跳校验和私网拦截继续生效。公开 GET 在已验证地址间按地址族交错、有界切换，POST 不重放。模型生成单次总预算最多120秒（含重试），搜索与本地网页读取最多15秒，Search API远程正文抓取最多45秒；调用方更短的超时和整次执行剩余时间始终优先。单次模型输入最多256,000、输出最多64,000 token，累计预算由调用方控制，供应商自身能力也会限制可用上下文和输出。供应商明确返回输出长度耗尽时抛出 `output_truncated`，即使残留 JSON 可解析也不交付为完整输出。模型目录仍保持原有短超时，不受生成上限影响。

模型 HTTP 402 或精确白名单额度错误码返回不可重试的 `model_quota_exceeded`，普通 429 仍按限流处理；不从任意错误消息推断余额。重试遵守有效的 `Retry-After`，等待超过当前调用期限时直接结束，不提前发起请求。
