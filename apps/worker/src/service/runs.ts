import { randomUUID } from 'node:crypto';
import {
    ReportConversationContextSchema,
    parseContract,
    type ReportConversationContext,
    type Budget,
    type TaskConfig,
    type Usage,
} from '@scova/models';
import type { RunRepository } from '@scova/execution/runs';
import {
    RunExecutionError,
    RunFenceError,
    type RunProgressEvent,
    type RunLeaseToken,
} from '@scova/execution/runs';
import { waitForPoll } from '@/utils/wait.ts';
import { within } from '@/utils/timeout.ts';
import { isRetryableExecutionFailure } from '@scova/execution/tool-failure';
import { AgentPersistenceError } from '@scova/execution/agent';
import { ConnectorError } from '@scova/connectors';

function failureCode(error: unknown): string {
    if (error instanceof RunExecutionError) return error.code;
    if (error instanceof AgentPersistenceError) {
        if (error.code === 'MODEL_QUOTA_EXCEEDED' || error.code === 'BUDGET_EXCEEDED')
            return error.code;
    }
    if (error instanceof ConnectorError) {
        if (error.code === 'configuration') return 'AGENT_CONFIGURATION_INVALID';
        if (error.code === 'model_quota_exceeded') return 'MODEL_QUOTA_EXCEEDED';
        if (error.code === 'budget_exceeded') return 'BUDGET_EXCEEDED';
    }
    return 'EXECUTOR_FAILED';
}

export interface RunExecutionContext {
    readonly conversation?: ReportConversationContext;
    readonly runId: string;
    readonly userId: string;
    readonly taskId: string;
    readonly taskVersionId: string;
    readonly mode: 'demo' | 'live';
    readonly config: TaskConfig;
    readonly budget: Budget;
    readonly usage: Usage;
    readonly deadlineAt: Date;
    readonly startedAt?: Date;
    readonly signal: AbortSignal;
    /** Worker lifetime fence; unlike the execution signal, deadline does not abort this signal. */
    readonly controlSignal?: AbortSignal;
    assertActive(): Promise<void>;
    emit(event: RunProgressEvent): Promise<void>;
}

export interface RunExecutor {
    /** #14 注入持久化 Agent；#16 交付事务负责成功，返回 void 本身不是成功。 */
    execute(context: RunExecutionContext): Promise<void>;
    /** Trusted worker adapter: persisted evidence only, still fenced against cancel/lost lease. */
    onDeadline?(context: RunExecutionContext): Promise<void>;
    /** Wait only for already-started persistence work, never external provider promises. */
    drain?(): Promise<void>;
}

export interface RunServiceOptions {
    repository: RunRepository;
    executor?: RunExecutor;
    /** Trusted worker factory receives the lease; agent-core never receives it. */
    executorFactory?: (token: RunLeaseToken) => RunExecutor;
    workerId?: string;
    leaseMs?: number;
    renewIntervalMs?: number;
    deadlineDeliveryTimeoutMs?: number;
}

export type RunExecutionResult = 'processed' | 'ignored' | 'busy' | 'stopped';
type AbortReason = 'stop' | 'lost' | 'canceled' | 'deadline' | 'finished';

/** 外部执行不持数据库锁；续期、控制终结与所有进度写入均使用 PG fencing。 */
export class RunService {
    private readonly repository: RunRepository;
    private readonly executor: RunExecutor | undefined;
    private readonly executorFactory: RunServiceOptions['executorFactory'];
    private readonly workerId: string;
    private readonly leaseMs: number;
    private readonly renewIntervalMs: number;
    private readonly deadlineDeliveryTimeoutMs: number;

    constructor(options: RunServiceOptions) {
        this.repository = options.repository;
        this.executor = options.executor;
        this.executorFactory = options.executorFactory;
        this.workerId = options.workerId ?? `worker-${randomUUID()}`;
        this.leaseMs = options.leaseMs ?? 30_000;
        this.deadlineDeliveryTimeoutMs = options.deadlineDeliveryTimeoutMs ?? 30_000;
        if (
            !Number.isSafeInteger(this.deadlineDeliveryTimeoutMs) ||
            this.deadlineDeliveryTimeoutMs < 1 ||
            this.deadlineDeliveryTimeoutMs > 60_000
        )
            throw new Error('截止交付超时必须为 1 至 60000 的整数毫秒数');
        this.renewIntervalMs = options.renewIntervalMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 3 || this.leaseMs > 3_600_000)
            throw new Error('Run 租约毫秒数必须为 3 至 3600000 的整数');
        if (
            !Number.isSafeInteger(this.renewIntervalMs) ||
            this.renewIntervalMs < 1 ||
            this.renewIntervalMs >= this.leaseMs
        )
            throw new Error('Run 续期间隔必须为小于租约的正整数毫秒数');
    }

    async execute(runId: string, signal?: AbortSignal): Promise<RunExecutionResult> {
        if (signal?.aborted) return 'stopped';
        const claimStartedAt = performance.now();
        const claimed = await this.repository.claim(runId, this.workerId, this.leaseMs, {
            allowDeadlineRecovery: !!(this.executor?.onDeadline || this.executorFactory),
        });
        if (claimed.kind !== 'claimed') return claimed.kind;
        const { token, run } = claimed;
        let executor: RunExecutor | undefined;
        if (signal?.aborted) {
            await this.repository.release(token);
            return 'stopped';
        }
        const controller = new AbortController();
        const pending = new Set<Promise<unknown>>();
        const track = <T>(operation: () => Promise<T>): Promise<T> => {
            const task = operation();
            pending.add(task);
            void task.then(
                () => pending.delete(task),
                () => pending.delete(task),
            );
            return task;
        };
        const heartbeatController = new AbortController();
        const controlController = new AbortController();
        let reason: AbortReason | undefined;
        const abort = (next: AbortReason) => {
            if (next !== 'deadline') {
                heartbeatController.abort();
                if (!controlController.signal.aborted) controlController.abort(next);
            }
            if (reason && reason !== 'deadline') return;
            reason = next;
            if (!controller.signal.aborted) controller.abort(next);
        };
        const interruption = (): 'stopped' | 'ignored' | undefined =>
            reason === 'stop' ? 'stopped' : reason === 'lost' ? 'ignored' : undefined;
        const stopping = () => abort('stop');
        signal?.addEventListener('abort', stopping, { once: true });
        if (signal?.aborted) stopping();
        let wakeAbort: (() => void) | undefined;
        const aborted = new Promise<'aborted'>((resolve) => {
            wakeAbort = () => resolve('aborted');
            controller.signal.addEventListener('abort', wakeAbort, { once: true });
        });
        const handleFenceError = (error: unknown) => {
            if (error instanceof RunFenceError)
                abort(
                    error.code === 'RUN_CANCELED'
                        ? 'canceled'
                        : error.code === 'DEADLINE_EXCEEDED'
                          ? 'deadline'
                          : 'lost',
                );
        };
        const assertActive = async () => {
            if (controller.signal.aborted) throw new Error('Run 执行已停止');
            try {
                await track(() => this.repository.assertActive(token));
            } catch (error) {
                handleFenceError(error);
                throw error;
            }
            if (controller.signal.aborted) throw new Error('Run 执行已停止');
        };
        // 用 PG 返回的剩余时长和单调时钟独立计时；慢续期不能推迟外部调用中断。
        const deadlineDelayMs = run.deadlineAt!.getTime() - claimed.now.getTime();
        const deadlineStartedAt = claimStartedAt;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleDeadline = () => {
            const remainingMs = deadlineDelayMs - (performance.now() - deadlineStartedAt);
            if (remainingMs <= 0) {
                abort('deadline');
                return;
            }
            // 正常预算只需一次定时；极长的已有快照分段，避免 Node 定时器整数溢出。
            deadlineTimer = setTimeout(
                scheduleDeadline,
                Math.min(Math.ceil(remainingMs), 2_147_483_647),
            );
        };
        scheduleDeadline();
        const heartbeat = (async () => {
            while (!heartbeatController.signal.aborted) {
                await waitForPoll(this.renewIntervalMs, heartbeatController.signal);
                if (heartbeatController.signal.aborted) return;
                try {
                    const result = await this.repository.renew(token, this.leaseMs, {
                        allowDeadline: reason === 'deadline',
                    });
                    if (result !== 'renewed') {
                        abort(result);
                        if (result !== 'deadline') return;
                    }
                } catch {
                    // DB 不可用时停止外部动作；不能猜测仍持有租约或写失败覆盖接管者。
                    abort('lost');
                    return;
                }
            }
        })();
        let context: RunExecutionContext | undefined;
        let deadlineHandled = false;
        let deadlineFailure: { error: unknown } | undefined;
        const handleDeadline = async () => {
            const deadlineExecutor = executor;
            if (
                reason !== 'deadline' ||
                deadlineHandled ||
                !context ||
                !deadlineExecutor?.onDeadline
            )
                return deadlineFailure;
            deadlineHandled = true;
            // Deterministic delivery is allowed past the research deadline, but never indefinitely
            // or after worker stop/lease loss. Its own adapter drains only started domain writes.
            let wakeControl: (() => void) | undefined;
            const interrupted = new Promise<void>((resolve) => {
                wakeControl = resolve;
                controlController.signal.addEventListener('abort', wakeControl, { once: true });
                if (controlController.signal.aborted) resolve();
            });
            const operation = Promise.resolve().then(() => {
                if (!controlController.signal.aborted)
                    return deadlineExecutor.onDeadline!(context!);
            });
            const timer = setTimeout(() => abort('lost'), this.deadlineDeliveryTimeoutMs);
            try {
                await Promise.race([operation, interrupted]);
            } catch (error) {
                // Keep the callback outcome available to both entry paths, including a claim
                // whose deadline elapsed before assertActive first ran.
                deadlineFailure = { error };
            } finally {
                clearTimeout(timer);
                if (wakeControl) controlController.signal.removeEventListener('abort', wakeControl);
            }
            return deadlineFailure;
        };
        try {
            executor = this.executor ?? this.executorFactory?.(token);
            if (!executor) {
                await assertActive();
                await this.repository.finish(token, { code: 'EXECUTOR_NOT_CONFIGURED' });
                return 'processed';
            }
            context = {
                ...(run.conversationContextJson
                    ? {
                          conversation: parseContract(
                              ReportConversationContextSchema,
                              run.conversationContextJson,
                          ),
                      }
                    : {}),
                runId: run.id,
                userId: run.userId,
                taskId: run.taskId,
                taskVersionId: run.taskVersionId,
                mode: run.mode,
                config: claimed.config,
                budget: claimed.budget,
                usage: claimed.usage,
                deadlineAt: run.deadlineAt!,
                startedAt: run.startedAt!,
                signal: controller.signal,
                controlSignal: controlController.signal,
                assertActive,
                emit: async (event) => {
                    if (controller.signal.aborted) throw new Error('Run 执行已停止');
                    try {
                        await track(() => this.repository.emit(token, event));
                    } catch (error) {
                        handleFenceError(error);
                        throw error;
                    }
                },
            };
            await assertActive();
            // 不合作的执行器也不能阻止停止或租约失效；迟到返回只被丢弃。
            const execution = Promise.resolve()
                .then(async () => {
                    await assertActive();
                    return executor!.execute(context!);
                })
                .then(
                    () => ({ kind: 'returned' as const }),
                    (error: unknown) => {
                        handleFenceError(error);
                        return { kind: 'failed' as const, error, code: failureCode(error) };
                    },
                );
            const result = await Promise.race([execution, aborted]);
            if (reason === 'stop' || reason === 'lost')
                return reason === 'stop' ? 'stopped' : 'ignored';
            if (
                result !== 'aborted' &&
                result.kind === 'failed' &&
                isRetryableExecutionFailure(result.error)
            )
                return 'ignored';
            if (reason === 'deadline') {
                // This callback has no external tools; its domain read/delivery validates current lease and cancellation.
                const failedDeadline = await handleDeadline();
                if (failedDeadline) throw failedDeadline.error;
            }
            const interrupted = interruption();
            if (interrupted) return interrupted;
            await this.repository.finish(token, {
                code:
                    reason === 'deadline'
                        ? 'DEADLINE_EXCEEDED'
                        : result !== 'aborted' && result.kind === 'returned'
                          ? 'EXECUTOR_RETURNED_WITHOUT_DELIVERY'
                          : result !== 'aborted'
                            ? result.code
                            : 'EXECUTOR_FAILED',
            });
            return 'processed';
        } catch (error) {
            handleFenceError(error);
            if (reason === 'stop' || reason === 'lost')
                return reason === 'stop' ? 'stopped' : 'ignored';
            if (error instanceof RunFenceError && error.code === 'LEASE_LOST') return 'ignored';
            if (isRetryableExecutionFailure(error)) return 'ignored';
            const failedDeadline = await handleDeadline();
            const terminalError = failedDeadline?.error ?? error;
            handleFenceError(terminalError);
            const interrupted = interruption();
            if (interrupted) return interrupted;
            if (isRetryableExecutionFailure(terminalError)) return 'ignored';
            await this.repository.finish(token, {
                code:
                    reason === 'deadline' &&
                    (!failedDeadline || terminalError instanceof RunFenceError)
                        ? 'DEADLINE_EXCEEDED'
                        : failureCode(terminalError),
            });
            return 'processed';
        } finally {
            heartbeatController.abort();
            if (!controlController.signal.aborted) controlController.abort('finished');
            if (!controller.signal.aborted) controller.abort('finished');
            clearTimeout(deadlineTimer);
            signal?.removeEventListener('abort', stopping);
            if (wakeAbort) controller.signal.removeEventListener('abort', wakeAbort);
            await within(heartbeat, 6_000, 'Run 心跳停止超时');
            // 停止后拒绝新领域操作，已发起的短数据库事务收敛后才能释放连接。
            await within(Promise.allSettled(pending), 6_000, 'Run 持久化停止超时');
            await within(
                Promise.resolve().then(() => executor?.drain?.()),
                12_000,
                'Agent 停止超时',
            );
            if (reason === 'stop') await this.repository.release(token);
        }
    }
}
