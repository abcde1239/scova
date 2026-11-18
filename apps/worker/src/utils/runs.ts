import type { RunEvent } from '@scova/models';

export interface RunLeaseToken {
    readonly runId: string;
    readonly userId: string;
    readonly leaseOwner: string;
    readonly leaseEpoch: number;
}

type EventInput<T> = T extends RunEvent ? Pick<T, 'type' | 'payload'> : never;
export type RunEventInput = EventInput<RunEvent>;
export type RunProgressEvent = Exclude<
    RunEventInput,
    { type: `run.${string}` | 'report.published' }
>;

export type RunFenceCode = 'LEASE_LOST' | 'RUN_CANCELED' | 'DEADLINE_EXCEEDED';
export class RunFenceError extends Error {
    constructor(readonly code: RunFenceCode) {
        super(code);
        this.name = 'RunFenceError';
    }
}

/** Worker execution adapters report only stable, allowlisted failure codes. */
export class RunExecutionError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'RunExecutionError';
    }
}

export const RUN_ACTIVE_STATUSES = ['queued', 'running', 'recovering', 'cancel_requested'] as const;
export const RUN_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
    EXECUTOR_NOT_CONFIGURED: 'Agent 执行器尚未配置，未生成报告',
    EXECUTOR_FAILED: '执行器失败，未完成报告交付',
    EXECUTOR_RETURNED_WITHOUT_DELIVERY: '执行器已返回，但未完成报告交付',
    DEADLINE_EXCEEDED: '执行时间预算已耗尽，未完成报告交付',
    RECOVERY_LIMIT_EXCEEDED: '执行恢复次数已达到上限',
    INVALID_RUN_CONFIGURATION: '执行配置快照无效，未启动外部调用',
    AGENT_CONFIGURATION_INVALID: '任务模型或执行服务配置不可用',
    SEARCH_API_NOT_CONFIGURED: '请在账号中配置 Search API，或选择内置 SearXNG',
    SEARCH_CREDENTIAL_INVALID: '搜索密钥无法读取，请在账号中重新保存 Search API',
    SEARCH_API_READING_UNSUPPORTED:
        '所选 Search API 暂不支持独立网页读取，请改选 DeepSeek 或 Tavily',
    AGENT_DELIVERY_NOT_CONFIGURED: '研究候选已保存，但报告交付服务尚未接入',
    MODEL_QUOTA_EXCEEDED: '模型服务额度不足，请补充额度后新建执行',
    BUDGET_EXCEEDED: '执行调用预算已耗尽，未完成报告交付',
    NO_EVIDENCE: '没有可验证的已采集正文，未生成报告',
    INVALID_DELIVERY_EVIDENCE: '来源、引用或候选授权校验失败，未生成报告',
};
