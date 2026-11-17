# 报告组件测试入口

这里保存浏览器回归需要的测试源码，需随仓库提交，不是生成产物。入口仅由 `build:e2e` 的 test 模式构建；生产构建不包含这些 HTML 页面。

| 入口                                  | 浏览器测试                                  |
| ------------------------------------- | ------------------------------------------- |
| `report-topic-list.html`              | `tests/e2e/report-topic-list.spec.ts`       |
| `report-comparison.html`              | `tests/e2e/report-comparison-table.spec.ts` |
| `report-research.html`                | `tests/e2e/report-research.spec.ts`         |
| `report-research.html?sample=formats` | `tests/e2e/report-documents.spec.ts`        |

页面挂载实际报告组件，使用固定数据验证布局、证据引用、键盘交互和主题。截图、测试报告等运行产物放在根 `artifacts/`，不放入此目录。

四类预览使用同一组明确标注的虚构资料，分别保存简报大纲、对象清单、比较矩阵和研究章节，支持切换形式及明暗主题。它不创建任务或写入数据库。

“内容长度”可切换长段落与长链接样稿，“文字缩放”提供 100% / 200% 字号，用于验证各形式的弹性宽度、局部滚动和窄屏换行。反复切换不会修改常规样稿。
