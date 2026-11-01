# 邮箱注册

从登录页进入注册，按 RegisterInputSchema 提交邮箱、12至128字符密码与默认IANA时区。默认时区来自浏览器，提交前可以修改。通过统一requestlane端点与epoch生命周期交接Cookie会话，成功进入任务页。

字段错误定位到首个输入，已有邮箱可返回登录；注册关闭后表单停止提交并保留登录入口，限流与连接错误分别提示。失败保留当前输入，密码仅在表单内存中、成功或卸载清空，不写Pinia、日志或浏览器存储。原生提交与同步锁共同阻止重复请求。

`vp test apps/web/tests/register.test.ts` 与 `vp run test:e2e tests/e2e/register.spec.ts` 分别检查契约/交接与本地HTTP浏览器样本。真实Cookie注册另用独立API/数据库验收。表单采用弹性宽度与字号，支持窄屏、键盘和文字放大；没有邮件验证、邀请码或密码找回功能。
