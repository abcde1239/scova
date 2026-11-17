# 搜索服务配置

Scova 的搜索与正文提取由账号独立配置，与解析、任务执行模型分开保存。账号可选择 Search API 或自部署 SearXNG：Search API 负责搜索与网页读取，SearXNG 配合本地 Reader 读取来源正文。服务器不提供默认搜索 Agent 或搜索 API 密钥。

## 独立搜索 API

在「账号 → Agent 配置 → 搜索与正文提取」选择 Search API，填写协议、HTTPS API 根地址和独立密钥。支持 DeepSeek Search / Fetch 与 Tavily Search / Extract，搜索与正文均由同一 API 服务提供。Perplexity Search 暂无独立网页读取接口，当前不可选；旧配置须改选支持搜索与读取的协议。切换、编辑或删除模型供应商不会改变搜索配置。保存不会调用搜索或模型接口，解析与报告问答不会因此自动联网。

任务可选择「Search API（搜索与网页读取）」或「内置 SearXNG＋网页读取工具」。前者由配置的 API 搜索并提取正文，后者使用聚合搜索与本地 Reader。API 模式不会调用本地网页读取工具，API 提取失败也不切换读取方式。报告的“待补充”还可能来自查询未命中目标、原站不可读、模型输入只覆盖部分正文，或生成答案没有覆盖所需字段，不能仅据此判断搜索引擎好坏。

搜索配置保存在独立账号记录中，搜索密钥单独加密，接口只返回 hasApiKey。同协议、同地址编辑时可留空保留；更改搜索协议或地址必须重新填写搜索密钥。切换到 SearXNG 会保留 API 配置，方便任务显式使用 API。

任务的「沿用账号搜索配置」读取此处默认方式，账号未设置时默认使用内置 SearXNG，立即执行可临时覆盖。Search API 按需配置；显式选择 API 却未保存密钥时，会提示配置 API 或选择内置搜索，不使用模型密钥、旧模型内嵌搜索或环境变量兜底。

查看执行时，内置搜索等待超过15秒或出现搜索 warning/error，会显示可关闭的提示并提供 Search API 配置入口。同次查看仅提示一次，不自动切换服务，也不阻止继续使用 SearXNG；历史日志回放不重复提醒。

升级须执行增量数据库迁移。旧模型中保存的独立搜索 API 可在该区域点击「迁入」复制为新账号配置；迁入后与原模型无关联。旧模型内置搜索授权不再用于任务搜索。原有 SEARCH_PROVIDER、SEARCH_API_* 和 TAVILY_API_KEY 不再作为服务器搜索配置读取，应从部署文件移除。

| 协议     | API 根地址                  | 搜索与读取接口              |
| -------- | --------------------------- | --------------------------- |
| deepseek | https://api.deepseek.com/v1 | tools/search 与 tools/fetch |
| tavily   | https://api.tavily.com      | search 与 extract           |

DeepSeek 搜索词最多128个 Unicode 码点，Tavily 最多2,000个，过长明确失败。接口可能另行计费，搜索密钥不会继承 MODEL_API_KEY。

账号 API 地址可指定兼容服务的 HTTPS 根地址（含版本或路径前缀，省略具体接口），必须同时实现所选协议的搜索和读取接口。部署的 SEARCH_DNS_RESOLVER=auto 仅管理 API 网络解析，保留公网校验与 Fake-IP 可信解析，可选 system、alidns、cloudflare、google；它不选择搜索服务或保存凭据。禁止请求重定向，默认不重试或切换渠道。Worker 每次搜索请求计一次搜索，最多保留10条候选；远程提取请求计入读取预算。

### API 网页读取

DeepSeek 搜索始终请求 need_content=true，只采用 content；Tavily 始终请求 include_raw_content=true、include_answer=false，只采用 raw_content。snippet、summary、Tavily 搜索的 content 和生成答案均不作为正文。已有非空、未被本地裁剪的 API 正文通过读取阶段校验后保存；正文缺失或已被本地裁剪时，使用同一 API 的 Fetch / Extract 读取指定 URL。显式优先来源也可直接调用远程读取，不依赖先前搜索命中。

正文从当前账号、当前执行的持久搜索账本恢复，成功读取后保存独立快照，跨执行租约恢复不依赖内存缓存。API 模式不访问原站核实、不调用本地 Reader，也不因网络、HTTP 或提取失败回退本地工具。取消、URL 安全、租约与预算错误继续传播。API 提取保留 search-api 来源标识；非空、哈希匹配或未本地裁剪均不代表已经证明整页覆盖。不同快照不会拼接成全文，API 日期也不当作已核实的页面发布时间。

远程读取沿用15秒整体时限及页面/尝试预算，复用已提交的读取结果不会再次联网或重复计页。每次 HTTP 响应上限2 MiB；搜索账本保留正文每页最多100,000个 Unicode 码点、合计最多800,000 UTF-8字节，远程单页读取最多保留1,000,000个正文字符；局部裁剪另有标记。历史 contentMode 的 reader / prefer_api 两值均兼容为 API 读取，新写入统一保存 prefer_api，不再提供本地读取策略选项。

协议参考：[DeepSeek Search](https://api-docs.deepseek.com/api/search)、[DeepSeek Fetch](https://api-docs.deepseek.com/api/fetch)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。Perplexity 的 [Fetch URL 工具](https://docs.perplexity.ai/docs/agent-api/tools/fetch-url-content)属于另行计费的生成式 Agent API，当前不作为独立 Search API 读取使用。

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

SearXNG 配合本地 Reader 时，HTML 读取候选会跳过 URL 已明确标识的 PDF、办公文档、纯文本及论坛附件，继续选择可读取网页，不为这些候选消耗读取尝试；显式优先来源或冻结基线不支持时仍记录覆盖缺口。Search API 模式由服务商判断文档提取能力，不套用本地 HTML Reader 的格式筛选；正文继续经读取阶段和工具账本核验，不把摘要升级为证据。网页支持字符集解码；格式错误不等于仅支持 UTF-8，超限也可能来自主文档、DOM 或资源数量/大小。网页 403 应选择公开替代来源，超时还可能发生在渲染或提取阶段。

Reader 优先提取主 HTML 中已有正文，缺少正文时再进行有界浏览器渲染。保存文本保留段落、代码换行与缩进、列表和表格行列分隔。已识别的验证码、登录门和加载提示不计为成功正文；附属资源受限、仅有公开摘要/订阅预览、仍需分页或交互时保留可核验正文，并将覆盖标为不完整。提取使用可终止的独立进程；字符数、下载大小和执行时间分别受限，增加正文字符上限不会放开网络预算。

若网页阅读报 `unsafe_url`，先检查域名是否被代理 Fake-IP 解析成 `198.18.*` 等保留地址；网页读取默认 `READER_DNS_RESOLVER=auto` 仅在系统全部返回Fake-IP时经 Cloudflare 官方公网引导地址连接其 HTTPS DNS 重新解析，并继续验证/固定每一跳的公网IP与TLS证书；可设 `system` 禁用或显式选择 `alidns|cloudflare|google`。模型通道的默认回退保持独立。请勿关闭私网检查。搜索实例可以访问，不代表网页正文已可安全抓取。403 应检查 JSON 格式是否开启及实例访问控制；容器健康也不代表所有上游引擎可用。

进一步参考：[适配器用法](../../../packages/connectors/README.md)、[SearxNG 官方部署](https://docs.searxng.org/admin/installation-docker.html)与[JSON API](https://docs.searxng.org/dev/search_api.html)。
