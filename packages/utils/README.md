# @scova/utils

Server 与 Worker 共用的纯调度计算和有效执行范围指纹。源码导出，不连接数据库或队列。

`nextScheduledAt(plan, now)` 返回严格晚于当前时刻的计划；`dueSchedule(plan, nextRunAt, now)` 只补最近一次到期时点，并统计此前错过次数。每日和每周按当地日历推进，夏令时缺失取首个有效时刻，重复取较早一次。停机跨度上限 366000 天、时区跃迁上限 2048 次，超限明确失败。

`effectiveRunScopeHash(versionHash, mode)` 供手动和周期执行共用，保持模式及比较策略隔离。

## 开发

在仓库根目录运行：

```sh
vp test packages/utils/tests
vp run @scova/utils#build
```
