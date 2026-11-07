# 报告组件测试入口

这里保存浏览器回归需要的测试源码，需随仓库提交，不是生成产物。入口仅由 `build:e2e` 的 test 模式构建；生产构建不包含这些 HTML 页面。

| 入口                     | 浏览器测试                                  |
| ------------------------ | ------------------------------------------- |
| `report-topic-list.html` | `tests/e2e/report-topic-list.spec.ts`       |
| `report-comparison.html` | `tests/e2e/report-comparison-table.spec.ts` |
| `report-research.html`   | `tests/e2e/report-research.spec.ts`         |

页面挂载实际报告组件，使用固定数据验证布局、证据引用、键盘交互和主题。截图、测试报告等运行产物放在根 `artifacts/`，不放入此目录。
