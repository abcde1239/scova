# Web 字体交付

字体方向已由 [#88](https://github.com/abcde1239/scova/issues/88) 确认。这里提供加载声明和许可，页面用途排版与本地阅读偏好由后续功能消费；当前入口未自动挂载这些字体。

## 资产与许可

| 用途          | 锁定发行包                                 | 资源                             |  文件字节 |
| ------------- | ------------------------------------------ | -------------------------------- | --------: |
| 界面西文/数字 | `@fontsource-variable/inter@5.3.0`         | 一个 Latin normal WOFF2          |    48,256 |
| 界面中文      | `@fontsource-variable/noto-sans-sc@5.3.1`  | 101 个 Unicode normal WOFF2 分片 | 4,500,544 |
| 内容阅读      | `@fontsource-variable/noto-serif-sc@5.3.1` | 101 个 Unicode normal WOFF2 分片 | 6,030,988 |

所列中文总量是可部署的完整分片总量，并非首屏下载量。可变字重覆盖所需的 400、500、600，无需为三个字重分别下载文件。Inter 仅承接 Latin，不承诺中文或所有外语字形。其他字形按 Noto 已含字集或系统回退显示。

三个发行包均采用 SIL Open Font License 1.1，允许随软件嵌入、使用及分发，须保留版权和许可，不单独出售字体，修改时遵守保留名称要求。使用未修改的发行字体；完整发行许可保存在 [LICENSES.txt](../../../apps/web/public/fonts/LICENSES.txt)，Vite 会将其复制至部署的 `/fonts/LICENSES.txt`。升级依赖时重新核对许可、字集、资源体积和实际渲染。

## 消费方式

界面入口导入 `@/styles/fonts.css`，然后由用途排版层使用 `font-family: var(--scova-font-interface)`。该文件只定义字体与变量，不覆盖根字号或页面布局。界面回退依次为 Inter、Noto Sans SC、PingFang SC、Microsoft YaHei、system-ui、sans-serif。

打开报告/资料阅读时再导入 `@/styles/reading-fonts.css`，阅读内容使用 `font-family: var(--scova-font-reading)`，回退为 Noto Serif SC、Songti SC、STSong、SimSun、serif。表格、按钮和工具仍使用界面字体。阅读模块可通过动态 `import('@/styles/reading-fonts.css')` 交给 Vite 分离加载；避免在界面首屏预加载衬线字体。

所有声明使用 `font-display: swap`，URL 由 Vite 从 npm 本地依赖转换为同源带哈希资源；运行时没有 Google Fonts、CDN 或外部字体服务请求。保留上游 Unicode 分片，浏览器仅请求实际出现字符命中的分片；不要预加载整套中文字体。初次安装 npm 依赖需要包仓库访问，部署后的浏览器字体请求只访问本站。

保留浏览器默认根字号。后续字号、间距和尺寸用 rem/em 等相对单位，容器用百分比及 min/max/clamp；本项不设置固定像素布局，也不以视口单位单独限制文字缩放。

## 加载预算与验证

实施前给受控界面样本设置预算：首屏最多 24 个字体请求、1 MiB 字体文件；阅读打开后额外最多 24 个、1 MiB。该预算约束所列样本，真实页面接入后需按其中文内容重新测量，不能用字集总量或一个样本推导全站性能。

在 Chromium 受控生产构建样本中，1440/320 宽度首屏均请求 9 个字体文件、509,216 字节；打开阅读额外 9 个、637,324 字节，首屏无衬线请求。这里的字节是成功返回 WOFF2 文件的内容大小，不含 HTTP/TLS 开销或 CSS。接口与阅读文本分别使用三种字重，通过 DevTools 平台字体信息确认实际中文 glyph 来自 Noto Sans/Serif，而非只观察 CSS 字体列表。字体内部基础名称含 Thin/ExtraLight，实际字重以 CSS 400/500/600 与可变轴为准。

完全阻断字体请求的 320 宽度样本实际回退为 Microsoft YaHei / STSong，中文、英文、数字仍可读，按钮可点击。390 宽度以 300ms 延迟、64 KiB/s 下载及每个字体额外 1.5s 延迟验证回退到加载完成的切换，长标题与按钮无重叠、无整页溢出。所有样本保留默认根字号，使用弹性相对尺寸。以上为本机 Chromium 的受控字体交付测试，不代表真实业务页面、实体移动设备、所有操作系统或完整可访问性验收。

运行 `vp test apps/web/tests/fonts.test.ts` 核对发行许可保留、400/500/600、中文样本分片覆盖、有效 WOFF2 和资产预算。页面接入后在浏览器禁用缓存重新检查：

1. Network 仅有同源字体；记录首屏请求和字节，打开阅读前不出现 Noto Serif。
2. Rendered Fonts 检查实际中文及 Latin 字形，分别验证 400/500/600。
3. 阻断全部 `.woff2` 并刷新，核对文本可读和按钮操作；恢复后用慢网检查长标题与操作位置。
4. 在实际页面和目标设备另验缩放、滚动、键盘及字体加载失败；不要将本项样本代替后续页面验收。
