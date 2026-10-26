# 本机 SearxNG 搜索

Scova 默认通过自部署 SearxNG 聚合网络搜索，使用免费的上游引擎，不需要搜索 API 密钥。模型可继续使用部署者提供的远程服务；单独搜索不依赖模型。搜索结果只代表候选资料，网页正文由安全阅读器另外采集。

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

搜索配置在 `ops/searxng/settings.yml`：仅启用 Bing、DuckDuckGo 和 Brave 的免费网页引擎，开启 HTML/JSON，限制引擎超时与连接池。实际可用性取决于出口网络、上游限流和验证码，付费 API 费用为零不代表无限搜索或结果完整。

## 接入与验证

主机上的 connector 默认连接 `http://127.0.0.1:8080`；其他部署由服务端配置 `SEARXNG_BASE_URL`。该地址只能由部署者设置，不能来自用户任务或网页。容器内调用方应通过受控容器网络连接实例，`127.0.0.1` 始终指当前容器自身。

```sh
vp run test:search:live        # 一次真实公开搜索，不调用模型
vp run test:search:read        # 另读取首个结果的正文
vp run test:connectors:live    # 搜索、阅读、远程模型原文引用校验
```

完整模型烟测需 `MODEL_API_KEY`、`MODEL_NAME`，可选 `MODEL_BASE_URL`；命令不会自动加载或输出密钥，需由启动环境注入。不提供本地模型服务。Tavily 只通过显式选项使用，实例或上游失败不会切换到收费服务或演示数据。

搜索烟测输出 `search_passed` 或带缺口的 `search_partial`。上游验证码、超时、被过滤结果与截断分别记录；全失败明确报错。`read_passed` 才代表采集了正文；搜索摘要不能作为已读原文。当前环境的 DuckDuckGo 返回验证码，其他引擎仍取得真实来源，因此本次搜索属于部分覆盖。

若网页阅读报 `unsafe_url`，先检查域名是否被代理 Fake-IP 解析成 `198.18.*` 等保留地址；为正常网页配置真实 DNS 解析后重试，勿关闭私网检查。搜索实例可以访问，不代表网页正文已可安全抓取。403 应检查 JSON 格式是否开启及实例访问控制；容器健康也不代表所有上游引擎可用。

进一步参考：[适配器用法](../../../packages/connectors/README.md)、[SearxNG 官方部署](https://docs.searxng.org/admin/installation-docker.html)与[JSON API](https://docs.searxng.org/dev/search_api.html)。
