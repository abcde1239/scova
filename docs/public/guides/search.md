# 搜索服务配置

Scova 默认通过自部署 SearxNG 聚合网络搜索，不需要搜索 API 密钥。模型可使用独立的远程服务。搜索摘要只代表候选资料；正文可来自搜索 API 的页面提取，或由安全 Reader 采集。

## 独立搜索 API

在「账号 → Agent 配置」添加或编辑供应商，选择「研究搜索方式 → 独立搜索 API」，填写协议、HTTPS API 根地址和独立密钥。支持 DeepSeek、Perplexity、Tavily，默认「API 正文优先，Reader 补读」，也可选择始终使用 Reader。配置随研究执行所选的供应商生效，优先于部署默认搜索；任务固定供应商时使用该供应商。保存不会调用搜索或模型接口，需求整理与报告问答不会因此自动联网。

搜索密钥与模型密钥分别保存并一起加密，接口只返回 hasApiKey。同协议、同地址编辑时可留空保留；更改搜索协议或地址必须重新填写搜索密钥。选择「部署默认搜索」并保存会移除个人搜索配置。独立 API 与模型内置搜索只能选一种，失败不会切换到其他供应商。

管理员也可配置 Worker 的部署默认值，修改后重启 Worker：

```dotenv
SEARCH_PROVIDER=api
SEARCH_API_PROTOCOL=deepseek
SEARCH_API_KEY=your_search_api_key
SEARCH_API_CONTENT_MODE=prefer_api
```

| 协议       | API 根地址                  | 正文来源                                  |
| ---------- | --------------------------- | ----------------------------------------- |
| deepseek   | https://api.deepseek.com/v1 | need_content=true 时的 content            |
| perplexity | https://api.perplexity.ai   | 当前协议返回摘要，由 Reader 补读          |
| tavily     | https://api.tavily.com      | include_raw_content=true 时的 raw_content |

DeepSeek 搜索词最多128个 Unicode 码点，其余最多2,000个，过长明确失败。Perplexity 可设置 SEARCH_API_SEARCH_TYPE=web（默认）或 fast，其他协议留空。接口可能另行计费，搜索密钥不会继承 MODEL_API_KEY。

SEARCH_API_BASE_URL 可指定兼容服务的 HTTPS API 根地址（含版本或路径前缀，省略具体接口），必须实现所选协议。SEARCH_API_DNS_RESOLVER=auto 保留公网校验与 Fake-IP 可信解析，可选 system、alidns、cloudflare、google。禁止请求重定向，默认不重试或切换渠道。Worker 每次物理请求计一次搜索，最多保留10条候选。

### 正文优先与补读

SEARCH_API_CONTENT_MODE 支持 prefer_api 和 reader，环境变量省略时保留旧的 reader 行为。正文优先时，DeepSeek 请求 need_content=true，只采用 content；Tavily 请求 include_raw_content=true、include_answer=false，只采用 raw_content。snippet、summary、Tavily 的 content 和生成答案均不作为正文。API 的非空正文也可能只是局部片段，HTML 来源会在同一读取预算内由 Reader 核实原站正文；Perplexity 当前没有对应的正文返回字段。

成功搜索的正文从当前账号、当前执行的持久账本恢复，读取成功时保存原站快照；网络、HTTP、容量或提取失败时可保留原 API 片段，其整页覆盖继续标记未知。取消、URL 安全、租约和预算错误会停止，不以片段掩盖。Reader 不支持的 PDF 等附件只保留已有 API 提取，不声称已读取整篇。不同快照不会拼接成全文，API日期也不当作页面已核实的发布时间。

原站读取沿用15秒整体时限及页面/尝试预算，复用已提交的读取结果不会再次联网。API片段回退不额外发起请求或重复计页。每次HTTP响应上限2 MiB；搜索账本保留正文每页最多100,000个Unicode码点、合计最多800,000 UTF-8字节，局部裁剪另有标记。Reader另有独立的整页正文上限与覆盖校验。

原有 Tavily 部署方式 SEARCH_PROVIDER=tavily 和 TAVILY_API_KEY 继续可用，只返回候选摘要；需要正文优先时使用上面的 api 协议配置。默认仍为 SEARCH_PROVIDER=searxng。

## 模型内置搜索

在[账号 Agent 配置](agent-configuration.md)中编辑供应商的「研究搜索方式」，选择内置搜索。默认使用部署搜索；允许后，该供应商用于研究执行时，其内置搜索优先于部署搜索渠道。首批支持 OpenAI Responses Web Search 与 Anthropic Web Search；普通 OpenAI Chat Completions 兼容并不表示该地址实现 Responses 搜索。Gemini 等其他内置协议尚未接入。保存不调用搜索 API，也不会改变需求整理和报告问答的调用方式。

每次请求限制最多 1 次搜索工具调用，预留 1 次搜索、16,384 输入 Token 和 1,024 输出 Token；成功后按供应商报告的实际 Token 结算（含 Anthropic 缓存输入），失败或用量未知保留预留，不自动重试或回退。预算不足不会发起请求。内置搜索也受 Run 截止时间和取消控制，单次最多 120 秒。上游不能硬限制搜索带入的输入 Token；若返回用量超出预留，Worker 将停止后续调用，预留额度并非供应商收费上限。

只提取工具来源链接与标题，不使用模型生成答案、加密内容作为证据；来源正文仍由阅读器单独采集。升级需先执行新增数据库迁移，旧供应商保持内置搜索关闭。

协议参考：[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[DeepSeek Search](https://api-docs.deepseek.com/api/search)、[Perplexity Search](https://docs.perplexity.ai/api-reference/search-post)、[OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Anthropic Web Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)。

完整本地开发使用 `vp run local:up` 将 PostgreSQL、Redis、SearXNG 一起启动，搜索地址为 `http://127.0.0.1:18080`，配置统一在根 `.env.local`，见[本地开发环境](local-development.md)。下面的 `search:up` 是仅启动搜索的独立方案，使用自己的配置、端口和 Compose 项目。

## 启动

安装并启动 Docker Desktop（Windows 使用 Linux 容器），或 Linux Docker Engine + Compose。仓库根目录执行：

```sh
vp install
vp run search:up
vp run test:search:live
```

启动命令自动创建被 Git 忽略的 `.env.searxng`，生成随机实例密钥，保留已有文件。浏览器访问 [本机搜索](http://127.0.0.1:8080)。端口冲突时修改 `.env.searxng` 中的 `SCOVA_SEARXNG_PORT`，再次启动，并将调用方的 `SEARXNG_BASE_URL` 设置为对应地址。

```sh
vp run search:status
vp run search:down
```

`down` 仅移除本项目搜索容器和网络，保留缓存卷与本地配置。该部署不影响 Scova 的 PostgreSQL/Redis 测试服务。

## 资源与访问

配置使用一个 SearxNG 容器、一个 worker、两个阻塞线程，限制 1 CPU、512 MiB 内存，日志轮转。关闭公共实例特性与限流，不额外启动 Valkey；此配置仅用于个人低并发，端口只绑定 `127.0.0.1`。Docker Desktop 自身及 Scova 数据库、Worker、模型不包含在该上限内。

当前固定镜像版本为 `2026.10.24-ef0ec03da`，Compose 使用镜像摘要。2026-10-25 本机启动后观察约 97 MiB，少量搜索后约 110 MiB；这是本次观察，不是高并发或长时间峰值保证。升级时应更新摘要并重验 JSON API 和实际搜索。

搜索配置在 `ops/searxng/settings.yml`：默认地区 `zh-CN`，显式启用 Bing 国际搜索、DuckDuckGo 与 Google CSE，开启 HTML/JSON，仅查询第一页并限制引擎超时。当前出口的 `www.bing.com` 会重定向到中国网关，因此 Bing 通过 `cn.bing.com` 加 `ensearch=1` 使用国际搜索模式，并独立固定 `en-US` 地区。小型 `bing_international.py` 适配层以只读文件挂载，复用固定镜像的原生请求构建与结果解析，不修改其他引擎的地区。Brave 因当前出口返回 429、普通 Google 因适配器返回 403 暂时禁用；修改配置后须重启 SearxNG，新增或改变挂载时须重新执行 Compose up，并分别检查 `/config` 和真实查询。升级镜像须重验挂载路径、引擎加载、国际搜索参数与 Bing 跳转链接解析。

Google CSE 使用 SearxNG 自带的 `google cse` 适配器，无需 API Key；它通过 CSE 网页接口和配置的 CX 获取结果，默认使用第三方 CX，不是官方 Custom Search JSON API，也不保证标准 Google 全网覆盖或长期可用。可在该引擎配置中填写自己的 `CX`，再验证覆盖范围。

实际可用性取决于出口网络、上游限流和验证码。明确地区可以缓解当前 DuckDuckGo `all` 地区的验证码问题；更换端点不能保证 Bing 始终可用。429/拒绝访问配置为冷却 30 分钟，CAPTCHA 配置为 1 小时；当前 DuckDuckGo 适配器的部分验证码分支会覆盖暂停时长，因此仍应避免连续重试。连接池限制不是 QPS 限速，付费 API 费用为零不代表无限搜索或结果完整。

Worker 通过共享 Redis 控制各引擎：默认并发 1、请求启动间隔 10 秒；CAPTCHA 冷却 1 小时，429/明确拒绝访问冷却 30 分钟，可信 `Retry-After` 更晚时采用更长等待。冷却结束只允许一个探测，失败再次冷却；DDG 受阻时继续使用获准的 Bing/CSE。状态跨 Worker 和重启保留，Redis 不可用时停止新搜索出站，已有证据仍可交付。浏览器人工完成挑战的 Cookie 不会自动同步到 SearxNG，不能保证恢复。

同账号、相同查询与时间范围、实例和引擎组合可复用候选并合并在途请求，完整响应最多缓存 5 分钟，带缺口响应最多 1 分钟，空结果和失败不缓存。滚动范围按任务时区每日失效，报告仍逐次读取正文并核验冻结窗口。缓存命中也占一次逻辑搜索预算；重试另计，缓存不授予额外任务额度。

Scova 默认每次执行最多 10 次搜索（含重试），独立连接器默认返回 5 条、Worker 最多 10 条，内部最多选排 30 条候选，搜索词最多 2,000 字符。Agent 每读 3 个候选重新选择，余额允许时最多补搜 2 次。SearxNG 的一条聚合查询会触达多个获准引擎；CSE 内部还可能获取 token，资格次数不等于上游所有 HTTP 请求数。直接打开 SearxNG 或独立烟测绕过 Worker，共享节流保证只覆盖受管入口。

规划优先为不同对象安排互补查询。精确 `site:主机/文档路径` 无有效候选时，可在原预算内放宽到主机并保留版本与模块词；恢复查询最多100个UTF-16单位，不增加补搜次数。返回同域邮件、其他文档模块或明确不同版本不会被当成目标原文。多个对象共用一个问题时，也按对象检查是否找到候选；标题与URL匹配仅用于发现，不代表所需字段已经得到证实。请求 current 或具体版本而来源无法核实时，保留该限制。

部署变量 `SEARCH_ENGINE_INTERVAL_MS` 默认为 `10000`，`SEARCH_CACHE_ENABLED=false` 关闭候选缓存，`SEARCH_ADAPTIVE_ENABLED=false` 关闭补搜。`SEARCH_CONFIG_VERSION` 默认 `1`，搜索出口、地区或 CX 改变时需在所有 Worker 同步更新以隔离缓存；不要用改版本或清 Redis 来反复绕过验证码冷却。每次调用的等待、网络和解析仍受 15 秒硬期限及 Run 剩余时间限制。

## 接入与验证

主机上的 connector 默认连接 `http://127.0.0.1:8080`；其他部署由服务端配置 `SEARXNG_BASE_URL`。该地址只能由部署者设置，不能来自用户任务或网页。容器内调用方应通过受控容器网络连接实例，`127.0.0.1` 始终指当前容器自身。

```sh
vp run test:search:live        # 一次真实公开搜索，不调用模型
vp run test:search:read        # 另读取首个结果的正文
vp run test:connectors:live    # 搜索、阅读、远程模型原文引用校验
```

完整模型烟测需 `MODEL_API_KEY`、`MODEL_NAME`，可选 `MODEL_BASE_URL`；命令不会自动加载或输出密钥，需由启动环境注入。不提供本地模型服务。Tavily 只通过显式选项使用，实例或上游失败不会切换到收费服务或演示数据。

搜索烟测输出 `search_passed` 或带缺口的 `search_partial`。上游验证码、超时、被过滤结果与截断分别记录；全失败明确报错。`read_passed` 才代表采集了正文；搜索摘要不能作为已读原文。上游状态会随出口和时间变化；若全部引擎失败且无可用来源，连接器返回 `search_unavailable`，Worker日志显示 `TOOL_SEARCH_UNAVAILABLE`，不能将其解释为互联网没有相关信息。

HTML 读取候选会跳过 URL 已明确标识的 PDF、办公文档、纯文本及论坛附件，继续选择可读取网页，不为这些候选消耗读取尝试；显式优先来源或冻结基线不支持时仍记录覆盖缺口。搜索供应商已经提供正文时，仅保留其 URL 能力提示供选择，正文继续经读取阶段和工具账本核验，不把摘要升级为证据。网页支持字符集解码；格式错误不等于仅支持 UTF-8，超限也可能来自主文档、DOM 或资源数量/大小。网页 403 应选择公开替代来源，超时还可能发生在渲染或提取阶段。

Reader 优先提取主 HTML 中已有正文，缺少正文时再进行有界浏览器渲染。保存文本保留段落、代码换行与缩进、列表和表格行列分隔。已识别的验证码、登录门和加载提示不计为成功正文；附属资源受限、仅有公开摘要/订阅预览、仍需分页或交互时保留可核验正文，并将覆盖标为不完整。提取使用可终止的独立进程；字符数、下载大小和执行时间分别受限，增加正文字符上限不会放开网络预算。

若网页阅读报 `unsafe_url`，先检查域名是否被代理 Fake-IP 解析成 `198.18.*` 等保留地址；网页读取默认 `READER_DNS_RESOLVER=auto` 仅在系统全部返回Fake-IP时经 Cloudflare 官方公网引导地址连接其 HTTPS DNS 重新解析，并继续验证/固定每一跳的公网IP与TLS证书；可设 `system` 禁用或显式选择 `alidns|cloudflare|google`。模型通道的默认回退保持独立。请勿关闭私网检查。搜索实例可以访问，不代表网页正文已可安全抓取。403 应检查 JSON 格式是否开启及实例访问控制；容器健康也不代表所有上游引擎可用。

进一步参考：[适配器用法](../../../packages/connectors/README.md)、[SearxNG 官方部署](https://docs.searxng.org/admin/installation-docker.html)与[JSON API](https://docs.searxng.org/dev/search_api.html)。
