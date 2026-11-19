# 图标使用

Web 使用 community 同源的 `@vicons/ionicons5`（0.13.0），集中在 `utils/icons.ts` 显式导入 outline 图标。导航和重要动作用图标，正文和状态保留文字，不在每句或标签前添加装饰。

```vue
<button type="button"><app-icon name="create" />新建任务</button>
<icon-button icon="notifications" label="通知" />
```

`AppIcon` 始终是装饰图标：读屏忽略它，名称来自所属按钮或链接；独立纯图标操作使用必须传入 `label` 的 `IconButton`。使用原生控件处理禁用和键盘操作，不在 SVG 上注册点击。图标继承 `currentColor` 和控件光标，默认 `1.25em`；控件最小触屏目标 `2.75rem`，随字体增大，不使用固定像素尺寸。禁用控件保留可辨认的外观，焦点轮廓跟随当前文字颜色。

主题、响应式导航和页面分别在所属模块消费这些组件；不要动态导入整个图标全集，也不要将状态只表示为图标或颜色。

## 检查方法

1. 用 Tab/Shift+Tab 遍历导航、带文字按钮和纯图标按钮，核对可见焦点、名称和顺序；Enter/Space 不应重复写入。
2. 在真实读屏工具中读取当前焦点，再用浏览模式访问标题、表单、覆盖不足和状态。带文字控件不应额外读出装饰图形；纯图标控件须读出完整用途。
3. 在窄屏打开菜单并按 Escape 退出，核对焦点返回；检查禁用和忙碌状态。实际工具报读与自动化 AX/DOM 断言分别记录。
4. 生产路径与 test-only 图标样例分别登记工具、浏览器、构建和结果；清理专属测试账号及服务。

自动化入口为 `visual-foundation.spec.ts`、`base-pages-accessibility.spec.ts`，运行方式见[浏览器测试](browser-testing.md)。六宽、根文字放大、computed style 和可访问名称检查均不能代替实际读屏；移动 VoiceOver/TalkBack 按[移动设备检查](mobile-verification.md)另验。组件样例只在 test 构建开放，不表示生产额外提供该动作。

## 实际工具记录

桌面 NVDA 的代表路径验证尚待完成，当前不据截图或 AX 树声明读屏通过。后续记录需分别列出生产路径与 test-only 纯图标样例结果，以及未覆盖的设备和读屏组合。
