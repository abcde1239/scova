# Web 测试夹具

`pages/` 保存组件展示页及其固定素材，`routes.ts` 登记仅在 test 模式开放的 `/__examples/*` 路由。`reports/` 保存直接挂载真实报告组件的 HTML 入口。

这些文件是可复现测试的源码，随仓库提交。生产构建不注册这些路由，也不输出报告测试 HTML。`build:e2e` 对夹具执行 Vue 类型检查并生成测试构建，浏览器用例位于根 `tests/e2e/`。

测试日志、截图、trace 和生成报告写入忽略的根 `artifacts/`，不放入本目录。
