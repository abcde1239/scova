# 整体后端链路测试用例

## Overview

- **Feature**：真实 HTTP API、PostgreSQL Outbox、独立 Worker 进程与真实 BullMQ 队列的整体连通验证。
- **Requirements Source**：PRD US-01/US-02 的账号隔离、任务与幂等执行要求；现有 Worker 投递边界。
- **Test Coverage**：同一流程分别运行 API/Worker 的 Bun/Bun、Bun/Node、Node/Bun、Node/Node 四组合。
- **Last Updated**：2026-10-25。

## Test Case Categories

### 1. Functional Tests

#### TC-F-FLOW-001：账号到队列的跨进程链路

- **Requirement**：R1 实际网络请求可创建账号、任务和执行，持久化意图可由独立 Worker 送入真实队列。
- **Priority**：High。
- **Preconditions**：专用 PostgreSQL/Redis；可运行独立 Bun 与官方 vpx；随机 schema、队列和测试邮箱。
- **Test Steps**：
  1. 启动真实 API 进程，通过 HTTP 注册并登录两个账号。
  2. 所有者创建任务并以同一幂等键重复启动 Run；检查数据库中 Run、首事件、Outbox 各一条，尚未发送。
  3. 另一账号读取任务、执行或启动该任务，检查拒绝状态及持久化记录数。
  4. 启动独立 Worker 进程，等待真实 Outbox 的 sentAt，读取 BullMQ job。
  5. 停止 Worker；通过 API 创建第二项任务及待投递执行，再启动 Worker。
  6. 等第二行 sentAt 确认重启扫描确实运行，停止 Worker；重新发送原幂等命令，读取任务执行。
- **Expected Results**：
  - 注册登录成功并通过真实 Cookie/CSRF 写请求；跨账号均返回 404。
  - 重复命令返回同一 Run，原任务 Run/事件/Outbox 各一条。
  - 队列 job 名称、payload、稳定 run jobId 正确；首次投递 attempts=1，租约清空。
  - 重启后第一条的 attempts/sentAt 不变，队列仅含两个预期 job；原命令仍复用 Run。
  - Run 保持 queued，Report 为零，明确尚无 Agent 消费或报告交付。
  - API/Worker 均接收关闭消息并以零退出。
- **Postconditions**：清理自有随机 schema 与队列、断开连接；不执行 flushdb，不影响他人队列。

## Test Coverage Matrix

| Requirement ID           | Test Cases                   | 状态               |
| ------------------------ | ---------------------------- | ------------------ |
| R1 HTTP→PG→Worker→BullMQ | TC-F-FLOW-001 × 四运行时组合 | 四组合真实集成通过 |
| R2 账号隔离              | TC-F-FLOW-001 步骤3          | 同上               |
| R3 命令幂等及重启不重投  | TC-F-FLOW-001 步骤2、5、6    | 同上               |
| R4 双运行时生命周期      | TC-F-FLOW-001 × 四组合       | 同上               |

## Notes

- 自动测试入口：`vp test --config tests/backend-flow.vite.config.ts`；不能与清空共用 Redis 的套件并行。
- 数据库使用既有测试 fixture；业务动作全部通过真实 HTTP，Worker 仅由独立进程启动，未导入其应用源码。
- 等待以持久化状态为同步屏障，轮询有超时；不用固定 sleep 认定已经投递或扫描。
- 本例补充整体组合证据，认证错误、退避、租约抢占及失败恢复继续由各专门套件覆盖。
