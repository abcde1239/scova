import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    RunStatusSchema,
    UuidSchema,
    describeProperties,
} from '../common/schema.ts';
import { StepNameSchema, type StepName } from './steps.ts';

const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const AttemptSchema = Type.Object(
    {
        attemptId: UuidSchema,
        number: Type.Integer({ minimum: 1 }),
        status: Type.Union([
            Type.Literal('running'),
            Type.Literal('succeeded'),
            Type.Literal('failed'),
            Type.Literal('interrupted'),
            Type.Literal('unknown'),
            Type.Literal('canceled'),
        ]),
        startedAt: InstantSchema,
        finishedAt: Type.Union([InstantSchema, Type.Null()]),
        durationMs: Type.Union([Count, Type.Null()]),
    },
    { additionalProperties: false, description: '单次节点尝试；未确认提交时不标记成功' },
);

export const RunGraphSnapshotSchema = Type.Object(
    {
        runId: UuidSchema,
        graphVersion: Type.Union([Type.Literal(1), Type.Null()]),
        precision: Type.Union([Type.Literal('instances'), Type.Literal('legacy')]),
        seq: Count,
        runStatus: RunStatusSchema,
        nodes: Type.Array(
            Type.Object(
                { id: StepNameSchema, label: Type.String({ minLength: 1, maxLength: 80 }) },
                { additionalProperties: false },
            ),
            { maxItems: 15, description: '版本化静态节点顺序，未访问节点不能推断为跳过' },
        ),
        edges: Type.Array(
            Type.Object(
                { from: StepNameSchema, to: StepNameSchema },
                { additionalProperties: false },
            ),
            { maxItems: 50, description: '拓扑允许的路由，不代表本次执行实际走过的边' },
        ),
        instances: Type.Array(
            Type.Object(
                {
                    instanceId: UuidSchema,
                    step: StepNameSchema,
                    ordinal: Type.Integer({ minimum: 1 }),
                    attempts: Type.Array(AttemptSchema, { minItems: 1, maxItems: 8 }),
                },
                { additionalProperties: false },
            ),
            { maxItems: 256, description: '保留当前及最近节点实例；历史裁剪由truncated标记' },
        ),
        legacySteps: Type.Array(
            Type.Object(
                { step: StepNameSchema, started: Count, completed: Count },
                { additionalProperties: false },
            ),
            { maxItems: 15, description: '缺少实例身份的历史事件计数，不推断尝试配对' },
        ),
        historyComplete: Type.Boolean({ description: '是否具有从入队开始的完整投影历史' }),
        truncated: Type.Boolean({ description: '是否因实例或尝试上限裁剪历史' }),
    },
    {
        additionalProperties: false,
        description: '当前账号执行的只读节点状态快照；seq与持久化事件投影一致',
    },
);
describeProperties(RunGraphSnapshotSchema);

export type RunGraphSnapshot = Static<typeof RunGraphSnapshotSchema>;
export type RunGraphAttempt = RunGraphSnapshot['instances'][number]['attempts'][number];
export type RunGraphState = Omit<RunGraphSnapshot, 'nodes' | 'edges'>;

export const RESEARCH_GRAPH_VERSION = 1 as const;
export const RESEARCH_GRAPH_NODES: ReadonlyArray<{ id: StepName; label: string }> = [
    { id: 'load_context', label: '加载上下文' },
    { id: 'plan', label: '规划问题' },
    { id: 'model_draft', label: '知识草稿' },
    { id: 'search', label: '搜索来源' },
    { id: 'select', label: '选择来源' },
    { id: 'read', label: '读取正文' },
    { id: 'verify', label: '核验来源' },
    { id: 'synthesize', label: '综合回答' },
    { id: 'validate', label: '检查覆盖' },
    { id: 'gap_loop', label: '处理缺口' },
    { id: 'conflict_review', label: '复核冲突' },
    { id: 'answer_supplement', label: '补充回答' },
    { id: 'model_answer', label: '模型补答' },
    { id: 'compare', label: '比较变化' },
];

const routes: ReadonlyArray<readonly [StepName, readonly StepName[]]> = [
    ['load_context', ['plan']],
    ['plan', ['model_draft', 'search']],
    ['model_draft', ['model_draft', 'search']],
    ['search', ['search', 'select']],
    ['select', ['search', 'read', 'verify']],
    ['read', ['read', 'select']],
    ['verify', ['synthesize', 'compare']],
    ['compare', ['synthesize']],
    ['synthesize', ['validate']],
    ['conflict_review', ['validate']],
    ['gap_loop', ['model_answer', 'compare', 'search', 'read', 'conflict_review', 'synthesize']],
    ['model_answer', ['model_answer', 'compare']],
    ['answer_supplement', ['model_answer', 'compare', 'search']],
    [
        'validate',
        [
            'compare',
            'model_answer',
            'conflict_review',
            'synthesize',
            'answer_supplement',
            'gap_loop',
        ],
    ],
];

export const RESEARCH_GRAPH_EDGES: ReadonlyArray<{ from: StepName; to: StepName }> = routes.flatMap(
    ([from, destinations]) => destinations.map((to) => ({ from, to })),
);

export function runGraphSnapshot(state: RunGraphState): RunGraphSnapshot {
    return {
        ...state,
        nodes: state.graphVersion === 1 ? RESEARCH_GRAPH_NODES.map((node) => ({ ...node })) : [],
        edges: state.graphVersion === 1 ? RESEARCH_GRAPH_EDGES.map((edge) => ({ ...edge })) : [],
    };
}
