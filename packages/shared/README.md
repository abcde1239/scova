# @scova/shared

不依赖 Scova 业务模型的通用辅助函数。目前提供时区与日历调度计算，源码导出，不连接数据库、队列或外部服务。

`nextScheduledAt(plan, now)` 返回严格晚于当前时刻的计划；`dueSchedule(plan, nextRunAt, now)` 只补最近一次到期时点，并统计此前错过次数。每日和每周按当地日历推进，夏令时缺失取首个有效时刻，重复取较早一次。停机跨度上限 366000 天、时区跃迁上限 2048 次，超限明确失败。

Server/Worker 的执行协议由 `@scova/execution` 提供。研究范围指纹、账号凭据和 checkpoint 版本读取由 Server 内部维护。

## 开发

在仓库根目录运行：

```sh
vp test packages/shared/tests
vp run @scova/shared#build
```
