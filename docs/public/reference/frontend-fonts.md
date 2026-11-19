# Web 字体交付

字体方向已由 [#88](https://github.com/abcde1239/scova/issues/88) 确认。工作台和业务组件使用共享用途排版，`/account/appearance` 提供本地阅读偏好和预览。页面按用途应用样式，不逐页引入字体；下列字体预算与字形结果仍仅对应所述受控样本。

## 资产与许可

| 用途          | 锁定发行包                                 | 资源                             |  文件字节 |
| ------------- | ------------------------------------------ | -------------------------------- | --------: |
| 界面西文/数字 | `@fontsource-variable/inter@5.3.0`         | 一个 Latin normal WOFF2          |    48,256 |
| 界面中文      | `@fontsource-variable/noto-sans-sc@5.3.1`  | 101 个 Unicode normal WOFF2 分片 | 4,500,544 |
| 内容阅读      | `@fontsource-variable/noto-serif-sc@5.3.1` | 101 个 Unicode normal WOFF2 分片 | 6,030,988 |

所列中文总量是可部署的完整分片总量，并非首屏下载量。可变字重覆盖所需的 400、500、600，无需为三个字重分别下载文件。Inter 仅承接 Latin，不承诺中文或所有外语字形。其他字形按 Noto 已含字集或系统回退显示。

三个发行包均采用 SIL Open Font License 1.1，允许随软件嵌入、使用及分发，须保留版权和许可，不单独出售字体，修改时遵守保留名称要求。使用未修改的发行字体；完整发行许可保存在 [LICENSES.txt](../../../apps/web/public/fonts/LICENSES.txt)，Vite 会将其复制至部署的 `/fonts/LICENSES.txt`。升级依赖时重新核对许可、字集、资源体积和实际渲染。

## 消费方式

`main.ts` 统一导入 `@/main.css`，保存界面字体声明与结构性排版；用途类由 `unocss.config.ts` 的 shortcuts 管理。naive-ui 与根界面均使用 `var(--scova-font-interface)`。界面回退依次为 Inter、Noto Sans SC、PingFang SC、Microsoft YaHei、system-ui、sans-serif。实际 Fontsource 族名包含 `Variable`，不要另写不匹配的字体族名。

内容标题、报告或笔记组件在 setup 中调用 `useReadingTypography()`，挂载时经共享 `loadReadingFonts()` 动态导入 `@/composable/reading-fonts.css`；非组件入口可直接调用后者。加载共享同一个 Promise，失败时保留系统回退并允许后续挂载重试。`ready` 只表示 CSS 加载完成，实际字形完成需等待浏览器字体加载。阅读字体回退为 Noto Serif SC、Songti SC、STSong、SimSun、serif。纯操作页不提前加载阅读 CSS；外观页因包含内容预览而加载。

| 用途                      | 共享 class                                        | 字体与字重                                           |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| 界面正文                  | `scova-interface` / `scova-ui`                    | Inter + Noto Sans SC，400                            |
| 操作 / 界面标题           | `scova-action` / `scova-heading`                  | 界面字体，500 / 600                                  |
| 内容列表标题 / 报告主标题 | `scova-content-title` / `scova-report-title`      | Noto Serif SC，600，不随正文偏好改变                 |
| 阅读正文 / 笔记           | `scova-reading` / `scova-note`                    | 默认 Noto Serif SC，400、行高 2；内部 h2/h3 小节 600 |
| 表格 / 警告 / 图注        | `scova-table` / `scova-warning` / `scova-caption` | 界面字体，不随正文偏好改变；图注 0.875rem            |
| 引用 / 问答工具           | `scova-citation-tools` / `scova-question-tools`   | 界面字体，不随正文偏好改变                           |

在阅读容器上应用正文 class，段落和列表继承设置；表格和原生交互控件保留界面字体。自定义警告、图注和工具组件需显式应用对应 class。内容标题使用独立 class，即使放在阅读容器中也保留衬线和 600。主标题及列表标题使用基于 rem 的 clamp，正文使用 `clamp(1rem, var(--scova-reading-size), 1.1875rem)`；不禁用浏览器缩放。

## 本地阅读偏好

`useReadingStore()` 只管理阅读正文族名 `serif` / `sans` 与 `1` / `1.0625` / `1.1875rem` 三档字号。`AppThemeProvider` 将对应 CSS 变量应用到工作台，界面、表格、警告、图注和工具继续使用独立的界面字体及字号。更新应使用 `setFamily()` / `setSize()`，不直接写入 store 字段。

设置只以 `{ version: 1, family, size }` 写入本机 `localStorage` 的 `scova.reading.v1`；刷新后恢复，没有账号同步。缺失、损坏、不支持的版本或选项回退到衬线/标准；存储被禁用或写入失败时仍可在当前页面切换。删除该 key 可恢复默认，不需要清除会话或其他偏好。

所有声明使用 `font-display: swap`，URL 由 Vite 从 npm 本地依赖转换为同源带哈希资源；运行时没有 Google Fonts、CDN 或外部字体服务请求。保留上游 Unicode 分片，浏览器仅请求实际出现字符命中的分片；不要预加载整套中文字体。初次安装 npm 依赖需要包仓库访问，部署后的浏览器字体请求只访问本站。

保留浏览器默认根字号。字号、间距和尺寸默认用 rem，局部随文字缩放的图标可用 em，容器用百分比及 min/max/clamp；px 仅用于必要且有说明的例外，不以视口单位单独限制文字缩放。

## 加载预算与验证

实施前给受控界面样本设置预算：首屏最多 24 个字体请求、1 MiB 字体文件；阅读打开后额外最多 24 个、1 MiB。该预算约束所列样本，真实页面接入后需按其中文内容重新测量，不能用字集总量或一个样本推导全站性能。

在 Chromium 受控生产构建样本中，1440/320 宽度首屏均请求 9 个字体文件、509,216 字节；打开阅读额外 9 个、637,324 字节，首屏无衬线请求。这里的字节是成功返回 WOFF2 文件的内容大小，不含 HTTP/TLS 开销或 CSS。接口与阅读文本分别使用三种字重，通过 DevTools 平台字体信息确认实际中文 glyph 来自 Noto Sans/Serif，而非只观察 CSS 字体列表。字体内部基础名称含 Thin/ExtraLight，实际字重以 CSS 400/500/600 与可变轴为准。

完全阻断字体请求的 320 宽度样本实际回退为 Microsoft YaHei / STSong，中文、英文、数字仍可读，按钮可点击。390 宽度以 300ms 延迟、64 KiB/s 下载及每个字体额外 1.5s 延迟验证回退到加载完成的切换，长标题与按钮无重叠、无整页溢出。所有样本保留默认根字号，使用弹性相对尺寸。以上为本机 Chromium 的受控字体交付测试，不代表真实业务页面、实体移动设备、所有操作系统或完整可访问性验收。

运行 `vp test apps/web/tests/reading-typography.test.ts` 核对本地偏好恢复和存储故障；字体实际加载、回退和请求预算由 `tests/e2e/visual-foundation.spec.ts` 验证，运行入口见[浏览器验证](browser-testing.md)。升级字体依赖时核对 `apps/web/public/fonts/LICENSES.txt` 中的发行许可。共享排版可在外观页及已接入的任务、收件箱/资料库、报告页面检查；本项样本不代替业务页面的完整验收。修改字体或页面内容后在浏览器禁用缓存重新检查：

1. Network 仅有同源字体；记录首屏请求和字节，打开阅读前不出现 Noto Serif。
2. Rendered Fonts 检查实际中文及 Latin 字形，分别验证 400/500/600。
3. 阻断全部 `.woff2` 并刷新，核对文本可读和按钮操作；恢复后用慢网检查长标题与操作位置。
4. 在实际页面和目标设备另验缩放、滚动、键盘及字体加载失败；不要将本项样本代替后续页面验收。

用途排版另在生产构建的外观页与注入的语义内容样本中验证：1440、320、390 宽度，默认根字号及测试环境 200% 文字（根字号 32px）均能重排，无整页横向溢出。切换正文族名与三档字号、刷新恢复和键盘选择有效；内容主标题、界面及排除项字体/字号保持独立。DevTools 平台字体信息确认中英文实际字形与 400/500/600，纯操作页不请求衬线字体。这是本机 Chromium 的文字缩放检查，不等同于完整浏览器缩放、真实业务页面或实体移动端验收。
