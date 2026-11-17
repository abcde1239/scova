import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
    InstantSchema,
    NonEmptyTextSchema,
    RunOutcomeSchema,
    UuidSchema,
    describeProperties,
} from './common.ts';
import { CoverageSchema, RunSchema, UsageSchema } from './runs.ts';
import { BudgetSchema } from './tasks.ts';
import { ModelDiagnosticSchema } from './model-diagnostics.ts';

const CountSchema = Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: '非负计数',
});
export const StepNameSchema = Type.Union(
    [
        Type.Literal('load_context'),
        Type.Literal('plan'),
        Type.Literal('search'),
        Type.Literal('select'),
        Type.Literal('read'),
        Type.Literal('verify'),
        Type.Literal('compare'),
        Type.Literal('synthesize'),
        Type.Literal('answer_supplement'),
        Type.Literal('model_answer'),
        Type.Literal('model_draft'),
        Type.Literal('gap_loop'),
        Type.Literal('conflict_review'),
        Type.Literal('validate'),
        Type.Literal('ready_for_delivery'),
    ],
    { description: '持久化 Agent 编排节点，不传输逐 token 过程或隐式思维链' },
);
const ToolNameSchema = Type.Union(
    [Type.Literal('search'), Type.Literal('read'), Type.Literal('model')],
    { description: '工具类别' },
);
const CommonEventProperties = {
    schemaVersion: Type.Literal(1, { description: '持久化事件结构版本；未知版本禁止静默解析' }),
    eventId: UuidSchema,
    runId: UuidSchema,
    seq: Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: '执行内严格递增的持久化序号',
    }),
    occurredAt: InstantSchema,
};
function eventSchema<N extends string, P extends TSchema>(
    name: N,
    payload: P,
    description: string,
) {
    return Type.Object(
        { ...CommonEventProperties, type: Type.Literal(name), payload },
        { additionalProperties: false, description },
    );
}
const ToolCallProperties = { toolCallId: UuidSchema, tool: ToolNameSchema };
export const RunEventSchema = Type.Union(
    [
        eventSchema(
            'research.updated',
            Type.Object(
                {
                    state: Type.Union([
                        Type.Literal('waiting'),
                        Type.Literal('cooldown'),
                        Type.Literal('cache_hit'),
                        Type.Literal('claims_repair'),
                    ]),
                },
                { additionalProperties: false },
            ),
            '研究阶段固定诊断，不包含提示词或上游原文',
        ),
        eventSchema(
            'run.queued',
            Type.Object(
                { status: Type.Literal('queued'), taskVersionId: UuidSchema },
                { additionalProperties: false },
            ),
            '执行已入队',
        ),
        eventSchema(
            'run.started',
            Type.Object(
                { status: Type.Literal('running'), startedAt: InstantSchema },
                { additionalProperties: false },
            ),
            '执行开始或接管后继续',
        ),
        eventSchema(
            'run.recovering',
            Type.Object(
                { status: Type.Literal('recovering'), recoveryCount: CountSchema },
                { additionalProperties: false },
            ),
            '执行等待恢复，不暴露 checkpoint 或租约细节',
        ),
        eventSchema(
            'step.started',
            Type.Object({ step: StepNameSchema }, { additionalProperties: false }),
            '编排节点开始',
        ),
        eventSchema(
            'step.completed',
            Type.Object(
                { step: StepNameSchema, durationMs: CountSchema },
                { additionalProperties: false },
            ),
            '编排节点完成',
        ),
        eventSchema(
            'tool.started',
            Type.Object(
                {
                    ...ToolCallProperties,
                    summary: NonEmptyTextSchema,
                    searchProvider: Type.Optional(
                        Type.Union([Type.Literal('searxng'), Type.Literal('api')], {
                            description: '本次搜索实际使用的方式，仅搜索工具提供',
                        }),
                    ),
                },
                { additionalProperties: false },
            ),
            '工具调用开始，只展示脱敏摘要',
        ),
        eventSchema(
            'tool.completed',
            Type.Object(
                { ...ToolCallProperties, durationMs: CountSchema, usage: UsageSchema },
                { additionalProperties: false },
            ),
            '工具调用完成与累计用量',
        ),
        eventSchema(
            'tool.failed',
            Type.Object(
                {
                    ...ToolCallProperties,
                    code: NonEmptyTextSchema,
                    message: NonEmptyTextSchema,
                    severity: Type.Optional(
                        Type.Union([Type.Literal('warning'), Type.Literal('error')], {
                            description:
                                '单次工具异常的影响等级；最终执行失败另记error，历史事件可省略',
                        }),
                    ),
                    retryable: Type.Boolean({ description: '是否允许在剩余预算内按策略重试' }),
                    modelDiagnostic: Type.Optional(ModelDiagnosticSchema),
                },
                { additionalProperties: false },
            ),
            '工具调用失败，不将失败解释为资料无变化',
        ),
        eventSchema(
            'budget.updated',
            Type.Object(
                { budget: BudgetSchema, usage: UsageSchema },
                { additionalProperties: false },
            ),
            '预算预留或累计消耗更新，包含重试',
        ),
        eventSchema('coverage.updated', CoverageSchema, '系统判定的查阅覆盖范围更新'),
        eventSchema(
            'report.published',
            Type.Object(
                {
                    reportId: UuidSchema,
                    completeness: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
                },
                { additionalProperties: false },
            ),
            '不可变报告已原子交付',
        ),
        eventSchema(
            'run.completed',
            Type.Union(
                [
                    Type.Object(
                        {
                            status: Type.Literal('succeeded'),
                            outcome: RunOutcomeSchema,
                            reportId: UuidSchema,
                        },
                        { additionalProperties: false },
                    ),
                    Type.Object(
                        {
                            status: Type.Literal('partial'),
                            outcome: Type.Union([
                                Type.Literal('important_change'),
                                Type.Literal('new_findings'),
                                Type.Literal('inconclusive'),
                            ]),
                            reportId: UuidSchema,
                        },
                        { additionalProperties: false },
                    ),
                ],
                { description: '完整或部分交付，部分交付不能声明完整无变化或建立基线' },
            ),
            '执行已完成交付',
        ),
        eventSchema(
            'run.failed',
            Type.Object(
                {
                    status: Type.Literal('failed'),
                    code: NonEmptyTextSchema,
                    message: NonEmptyTextSchema,
                },
                { additionalProperties: false },
            ),
            '执行终结失败，不创建伪报告',
        ),
        eventSchema(
            'run.canceled',
            Type.Object(
                { status: Type.Literal('canceled'), message: NonEmptyTextSchema },
                { additionalProperties: false },
            ),
            '执行已取消，不能继续交付',
        ),
    ],
    { description: '版本化持久化业务事件，具有 eventId 和严格递增 seq；不包含传输控制帧' },
);
export const EventCursorQuerySchema = Type.Object(
    {
        after: Type.Optional(
            Type.Integer({
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '只请求更大 seq 的事件，0 从最早可用事件开始',
            }),
        ),
    },
    { additionalProperties: false, description: 'SSE 历史回放序号游标' },
);
export const EventCursorHeadersSchema = Type.Object(
    {
        'last-event-id': Type.Optional(UuidSchema),
    },
    {
        additionalProperties: true,
        description: '断线重连时发送最后成功处理的持久化 eventId，服务端在当前 Run 内定位',
    },
);
export const SseResetControlSchema = Type.Object(
    {
        schemaVersion: Type.Literal(1),
        type: Type.Literal('stream.reset'),
        runId: UuidSchema,
        payload: Type.Object(
            {
                reason: Type.Literal('cursor_expired'),
                snapshot: RunSchema,
                resumeAfter: Type.Integer({
                    minimum: 0,
                    maximum: Number.MAX_SAFE_INTEGER,
                    description: '快照对应的最新持久化 seq，客户端替换快照后从该位置继续',
                }),
            },
            { additionalProperties: false },
        ),
    },
    {
        additionalProperties: false,
        description:
            '游标过期的 SSE 传输控制帧，不持久化、不分配 eventId 或 seq、不推进 Last-Event-ID',
    },
);
export const SseMessageSchema = Type.Union([RunEventSchema, SseResetControlSchema], {
    description: 'SSE 数据帧：持久化业务事件或无事件序号的 reset 控制帧',
});
for (const schema of [
    RunEventSchema,
    EventCursorQuerySchema,
    EventCursorHeadersSchema,
    SseResetControlSchema,
    SseMessageSchema,
])
    describeProperties(schema);
export type RunEvent = Static<typeof RunEventSchema>;
export type SseResetControl = Static<typeof SseResetControlSchema>;
export type SseMessage = Static<typeof SseMessageSchema>;
