# 图标使用

Web 使用 community 同源的 `@vicons/ionicons5`（0.13.0），集中在 `components/common/icons.ts` 显式导入 outline 图标。导航和重要动作用图标，正文和状态保留文字，不在每句或标签前添加装饰。

```vue
<button type="button"><app-icon name="create" />新建任务</button>
<icon-button icon="notifications" label="通知" />
```

`AppIcon` 始终是装饰图标：读屏忽略它，名称来自所属按钮或链接；独立纯图标操作使用必须传入 `label` 的 `IconButton`。使用原生控件处理禁用和键盘操作，不在 SVG 上注册点击。图标继承 `currentColor` 和控件光标，默认 `1.25em`；控件最小触屏目标 `2.75rem`，随字体增大，不使用固定像素尺寸。禁用控件保留可辨认的外观，焦点轮廓跟随当前文字颜色。

主题、响应式导航和页面分别在所属模块消费这些组件；不要动态导入整个图标全集，也不要将状态只表示为图标或颜色。
