# 本机 SearxNG 搜索

Scova 默认通过自部署 SearxNG 聚合网络搜索，使用免费的上游引擎，不需要搜索 API 密钥。模型可继续使用部署者提供的远程服务；单独搜索不依赖模型。搜索结果只代表候选资料，网页正文由安全阅读器另外采集。

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

DuckDuckGo 返回 CAPTCHA 后应暂停请求该引擎，先使用其他来源；恢复时从并发 1、每 5–10 秒一次开始观察。需要跨 Worker 生效的冷却与频率控制时，应增加共享出站调度，当前实例没有这层能力。浏览器人工完成同出口的挑战可以尝试，但浏览器 Cookie 不会自动同步到 SearxNG，不能保证恢复。

Scova 默认每次执行最多 10 次搜索（含重试），单次默认返回 5 条来源、最多 10 条，搜索词最多 2,000 字符。SearxNG 的一条聚合查询会触达多个启用引擎；多个任务并行时也会叠加上游频率。这里的任务预算、第一页限制、HTTP 超时和上游验证码分别生效，不能当作同一种搜索次数上限。

## 接入与验证

主机上的 connector 默认连接 `http://127.0.0.1:8080`；其他部署由服务端配置 `SEARXNG_BASE_URL`。该地址只能由部署者设置，不能来自用户任务或网页。容器内调用方应通过受控容器网络连接实例，`127.0.0.1` 始终指当前容器自身。

```sh
vp run test:search:live        # 一次真实公开搜索，不调用模型
vp run test:search:read        # 另读取首个结果的正文
vp run test:connectors:live    # 搜索、阅读、远程模型原文引用校验
```

完整模型烟测需 `MODEL_API_KEY`、`MODEL_NAME`，可选 `MODEL_BASE_URL`；命令不会自动加载或输出密钥，需由启动环境注入。不提供本地模型服务。Tavily 只通过显式选项使用，实例或上游失败不会切换到收费服务或演示数据。

搜索烟测输出 `search_passed` 或带缺口的 `search_partial`。上游验证码、超时、被过滤结果与截断分别记录；全失败明确报错。`read_passed` 才代表采集了正文；搜索摘要不能作为已读原文。上游状态会随出口和时间变化；若全部引擎失败且无可用来源，连接器返回 `search_unavailable`，Worker日志显示 `TOOL_SEARCH_UNAVAILABLE`，不能将其解释为互联网没有相关信息。

若网页阅读报 `unsafe_url`，先检查域名是否被代理 Fake-IP 解析成 `198.18.*` 等保留地址；网页读取默认 `READER_DNS_RESOLVER=auto` 仅在系统全部返回Fake-IP时经固定公网IP的可信HTTPS DNS重新解析，并继续验证/固定每一跳的公网IP与TLS证书；可设 `system` 禁用或显式选择 `alidns|cloudflare|google`。请勿关闭私网检查。搜索实例可以访问，不代表网页正文已可安全抓取。403 应检查 JSON 格式是否开启及实例访问控制；容器健康也不代表所有上游引擎可用。

进一步参考：[适配器用法](../../../packages/connectors/README.md)、[SearxNG 官方部署](https://docs.searxng.org/admin/installation-docker.html)与[JSON API](https://docs.searxng.org/dev/search_api.html)。
