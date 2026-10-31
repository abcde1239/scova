# 状态与动作

`StatePanel` 接收 `loading | empty | error | success`、必要说明 `message` 和 `retryable`，通过 `retry` 发出重试意图。状态有中文文字和礼貌播报，长地址换行。加载时重试按钮保留焦点并拦截重复激活；成功移除按钮后焦点进入成功说明。调用方负责服务状态和真实数据，不将组件当作 Query 缓存。

`ActionButton` 使用原生按钮语义，正常为 pointer，busy 为 progress，显式 disabled 优先为 not-allowed，内部图标与文字继承。busy 使用 aria-disabled 并实际阻止 click，保留焦点；disabled 同时使用原生 disabled。`useCommand().run()` 同步锁住同一在途用户动作，在成功或失败后释放，不自动重试。领域调用方使用稳定的幂等键和统一通信层。

普通内容 default；可编辑与可选择只读文字输入 text；原生 date/time 为 auto。不要给全页添加忙碌光标，也不要用 cursor 或 pointer-events 替代禁用语义与事件拦截。字号、间距和目标尺寸为相对单位，根字号由浏览器决定。

`vp run test:e2e -- tests/e2e/states.spec.ts` 使用单独的 test 模式构建访问 `/__examples/states`。该本地受控样例不请求服务器，不进入业务导航；正常 `vp run web#build` 不注册或打包样例页面。它不是业务加载、认证或研究旅程的验收。
