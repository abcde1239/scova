# Worker 架构测试用例

## Overview

- **Feature**：Worker 依赖装配、生命周期、串行 Outbox 轮询、租约与 BullMQ 投递。
- **Requirements Source**：PRD US-02；架构的 PostgreSQL 事实源、Outbox 至少一次传递与优雅停止约定；本轮 Worker 分层要求。
- **Test Coverage**：正常、边界、故障、租约状态转换；Agent 消费、报告交付、周期任务扫描不在本轮范围。
- **Last Updated**：2026-10-25。
- **已执行结果**：生命周期/配置 16 项单元通过；`vp run test:worker` 的 12 项真实集成通过，包括 Bun/Node 进程、Redis 恢复、租约接管和确认失败重投。完整 `vp run ready` 通过。
- **执行方式**：单元使用 deferred 与 fake timers 控制并发；数据库与 Redis 集成串行使用专用实例、随机 schema/队列。不得因进程打印 ready 就判定投递成功。

## Test Case Categories

### 1. Functional Tests

#### TC-F-001：惰性启动及串行批次

- **Requirement**：R1 生命周期及真实串行轮询。
- **Priority**：High。
- **Preconditions**：注入可控 connect 与挂起的 dispatch。
- **Test Steps**：构造应用，连续调用两次 start；完成连接；挂起首批并推进多个轮询间隔；完成首批后再推进一个间隔。
- **Expected Results**：构造不连接；连接一次；成功连接后才投递；同一时刻至多一批，前一批结束后开始计算等待时间。
- **Postconditions**：stop 后无定时器和连接。

#### TC-F-002：真实投递及稳定 jobId

- **Requirement**：R4 PostgreSQL Outbox 至少一次传递及 BullMQ 适配。
- **Priority**：High。
- **Preconditions**：专用 PostgreSQL/Redis；一条到期未投递记录。
- **Test Steps**：执行一批，读取持久化行与真实 job，再次扫描。
- **Expected Results**：job 的名称、payload 与稳定 run jobId 正确；仅当前租约可写 sentAt 并清租约；再次扫描投递零条。
- **Postconditions**：清理本例 schema/队列，不删除他人数据。

#### TC-F-003：Bun/Node 真实启动及停止

- **Requirement**：R5 Bun 主运行时、Node 兼容入口。
- **Priority**：High。
- **Preconditions**：有效专用服务配置与待投递记录。
- **Test Steps**：分别用正式 Bun/官方 vpx 启动；观察真实 job；发送关闭消息或信号；等待退出。
- **Expected Results**：真实投递发生；关闭等待在途批次并释放连接；退出码零，无占位 heartbeat 保活。不能仅断言 process.connected。
- **Postconditions**：无遗留子进程；清理测试数据。

### 2. Edge Case Tests

#### TC-E-001：配置默认值及边界

- **Requirement**：R2 有界配置及无凭据错误输出。
- **Priority**：High。
- **Preconditions**：传入独立 env 对象。
- **Test Steps**：省略可选值；检查每项最小/最大；输入零、负数、小数、空串、非数、超上限；检查队列名字符与长度；缺失/错误连接 URL。
- **Expected Results**：默认与边界可用；非法值拒绝；URL 错误只指出变量名，不回显原值或凭据。
- **Postconditions**：不修改进程环境，不建立连接。

#### TC-E-002：领取筛选、批量边界及竞争

- **Requirement**：R3 有限批量及租约 CAS。
- **Priority**：High。
- **Preconditions**：准备空表、未来到期、未过期租约、已发送、到期记录及可控时钟。
- **Test Steps**：以 limit=1/非法 limit 扫描；两个领取方同时竞争；验证租约过期时间边界。
- **Expected Results**：仅符合条件的记录可领取；单行只有一个胜者；空批返回零；非法上限拒绝；过期边界按明确契约执行。
- **Postconditions**：未领取记录不变。

### 3. Error Handling Tests

#### TC-ERR-001：分阶段启动失败清理

- **Requirement**：R1 部分初始化失败不遗留资源。
- **Priority**：High。
- **Preconditions**：分别令数据库连接、Redis 连接或队列就绪失败。
- **Test Steps**：调用 start，随后重复 stop；再模拟清理自身失败。
- **Expected Results**：已创建资源仍逐一尝试关闭且各一次；不发布 ready，不进入轮询；入口非零退出，日志固定脱敏。关闭一项失败不能跳过其他资源。
- **Postconditions**：没有打开的连接或轮询定时器。

#### TC-ERR-002：单批故障退避并继续

- **Requirement**：R1 投递错误不终止轮询；R3 丢租约不算成功。
- **Priority**：High。
- **Preconditions**：第一批抛出包含凭据的错误，后续批次成功。
- **Test Steps**：推进到失败延迟前一毫秒及到期时；再推进普通轮询间隔；另令 ack 报告失去租约。
- **Expected Results**：失败期间不热循环；到期后继续；成功后使用普通间隔；只输出固定错误文本；失租约不增加 delivered，并进入上层故障退避。
- **Postconditions**：stop 可唤醒故障等待。

#### TC-ERR-003：真实 Redis 失败后恢复

- **Requirement**：R4 队列失败不丢失数据库意图。
- **Priority**：High。
- **Preconditions**：隔离的发送连接或故障代理；有效 Outbox。
- **Test Steps**：令真实 Redis 投递失败；检查数据库；恢复连接并推进 availableAt 后重投。
- **Expected Results**：失败不写 sentAt，记录有界退避并释放有效租约；到期前不发送；恢复后可发送且 jobId 不变。
- **Postconditions**：恢复故障设施；禁止停止其他套件共用的 Redis。

### 4. State Transition Tests

#### TC-ST-001：幂等停止与在途等待

- **Requirement**：R1 shutdown 顺序与幂等。
- **Priority**：High。
- **Preconditions**：分别处于初始化、空闲等待、失败等待、在途投递状态。
- **Test Steps**：重复调用 stop；检查 signal；在途完成前后分别检查 close；完成后再推进时间并尝试 start。
- **Expected Results**：先 abort，等待初始化/在途完成后 close；等待立即可唤醒；close 一次；无后续批次；停止后拒绝重新启动。
- **Postconditions**：应用终止，无残留定时器。

#### TC-ST-002：新租约拒绝旧 ack

- **Requirement**：R3 租约 fencing。
- **Priority**：High。
- **Preconditions**：A 领取后暂停；可控时钟越过过期点，B 重新领取。
- **Test Steps**：A 迟到提交成功 ack，然后 B 提交。
- **Expected Results**：A 不得写 sentAt 或清除 B 租约；不计成功投递；B 可以正常提交。
- **Postconditions**：数据库反映 B 的提交结果。

#### TC-ST-003：新租约拒绝旧 retry

- **Requirement**：R3 失败路径同样 fencing。
- **Priority**：High。
- **Preconditions**：A 旧租约；B 已接管并持有新租约。
- **Test Steps**：A 迟到报告发送失败并请求退避；读取记录后由 B 提交。
- **Expected Results**：A 不得修改 B 的租约、availableAt 或 sentAt；B 仍可提交。
- **Postconditions**：有效持有者之外无写入。

#### TC-ST-004：发送成功、确认前崩溃后重投

- **Requirement**：R4 Outbox 至少一次传递与稳定 jobId。
- **Priority**：High。
- **Preconditions**：真实队列；在 publish 成功后、数据库 ack 前注入故障。
- **Test Steps**：保留未 sent 记录；等租约过期后另一个 dispatcher 重投。
- **Expected Results**：jobId 与 payload 相同，队列中仍为一个逻辑 job；当前租约最终可确认。未实现 Agent，不能据此宣称成果 exactly-once。
- **Postconditions**：记录已发送；清理测试数据。

## Test Coverage Matrix

| Requirement ID        | Test Cases                          | 验证位置与状态                                                                          |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| R1 生命周期与串行轮询 | TC-F-001、TC-ERR-001/002、TC-ST-001 | lifecycle.test.ts；runtime.integration.test.ts 验证 Redis 初始化失败后的真实退出        |
| R2 配置与脱敏         | TC-E-001、TC-ERR-002                | config.test.ts、lifecycle.test.ts；进程缺配置的非零退出与无凭据输出                     |
| R3 租约与批量         | TC-E-002、TC-ST-002/003、TC-ERR-002 | outbox-architecture.integration.test.ts 验证并发领取、旧 ack/retry 拒写、筛选和单批上限 |
| R4 BullMQ 可靠投递    | TC-F-002、TC-ERR-003、TC-ST-004     | outbox.integration.test.ts 与架构集成：真实队列、连接恢复、确认失败重投                 |
| R5 双运行时           | TC-F-003                            | runtime.integration.test.ts：Bun/Node 实际投递、IPC 停止与正常退出                      |

## Notes

- 共 12 例：功能 3、边界 2、错误 3、状态转换 4。矩阵区分测试计划与已验证证据，未跑集成不视为通过。
- 使用已有 Outbox 测试时保留用户原有额外断言；提交范围由主 agent 核对。
- 本轮不覆盖 Agent 消费、Run 执行 epoch、报告/收件箱幂等交付及周期任务调度。
- 初始化清理已覆盖应用级连接失败与真实 Redis 失败；未穷举所有驱动内部初始化异常。测试状态不等同完整生产故障验收。
