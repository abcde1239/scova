import { Type, type Static } from '@sinclair/typebox';
import {
    HttpUrlSchema,
    InstantSchema,
    ModeSchema,
    NonEmptyTextSchema,
    OutputFormatSchema,
    PageQuerySchema,
    RunOutcomeSchema,
    UuidSchema,
    refineSchema,
    describeProperties,
    pageSchema,
} from './common.ts';
import { CoverageSchema } from './runs.ts';
import { validReportValueClaims } from './report-value.ts';
import { classifyReportDelivery } from './report-delivery.ts';
import { researchCoverageMetrics } from './research-coverage.ts';
import { validReportArtifacts } from './report-artifact-validation.ts';
import { SourceDatesSchema } from './source-dates.ts';
import { FeedbackEffectsSchema } from './feedback.ts';

export const EvidenceSelectorSchema = refineSchema(
    Type.Object(
        {
            type: Type.Literal('text_offset'),
            start: Type.Integer({
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '正文起始字符偏移，含该字符',
            }),
            end: Type.Integer({
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER,
                description: '正文结束字符偏移，不含该字符',
            }),
            extractorVersion: NonEmptyTextSchema,
        },
        { additionalProperties: false, description: '引用在采集正文中的字符范围' },
    ),
    'ScovaEvidenceSelector',
    (value) => value.end > value.start,
);

export const EvidenceSnapshotSchema = Type.Object(
    {
        originalUrl: HttpUrlSchema,
        fetchedUrl: HttpUrlSchema,
        canonicalUrl: HttpUrlSchema,
        contentHash: Type.String({
            pattern: '^[a-f0-9]{64}$',
            description: '采集正文的 SHA-256 指纹',
        }),
        extractorVersion: NonEmptyTextSchema,
        publishedAt: Type.Union([InstantSchema, Type.Null()], {
            description: '来源发布时间，未确认时为空',
        }),
        sourceDates: Type.Optional(SourceDatesSchema),
        truncated: Type.Boolean({ description: '采集正文是否发生截断' }),
        selector: EvidenceSelectorSchema,
    },
    { additionalProperties: false, description: '引用可追溯的来源快照元数据，不包含完整正文' },
);

export const EvidenceSchema = Type.Object(
    {
        id: UuidSchema,
        sourceId: UuidSchema,
        snapshotId: UuidSchema,
        url: HttpUrlSchema,
        title: NonEmptyTextSchema,
        quote: NonEmptyTextSchema,
        location: Type.String({
            minLength: 1,
            description: '原文段落或字符位置的可解释定位，不执行页面选择器代码',
        }),
        observedAt: InstantSchema,
        snapshot: Type.Optional(EvidenceSnapshotSchema),
    },
    {
        additionalProperties: false,
        description: '原始证据片段，来源权限和执行归属仍由领域服务校验',
    },
);
export const ClaimKindSchema = Type.Union(
    [
        Type.Literal('fact'),
        Type.Literal('inference'),
        Type.Literal('conflict'),
        Type.Literal('insufficient'),
        Type.Literal('model_answer'),
    ],
    { description: '来源事实、Agent 推断、冲突证据或证据不足' },
);
const ClaimObject = Type.Object(
    {
        id: UuidSchema,
        kind: ClaimKindSchema,
        text: NonEmptyTextSchema,
        confidenceLabel: NonEmptyTextSchema,
        evidenceIds: Type.Array(UuidSchema, {
            uniqueItems: true,
            description: '引用的证据 ID，必须出现在报告可访问证据中',
        }),
    },
    { additionalProperties: false, description: '结构化结论，事实型结论至少有一条引用' },
);
export const ClaimSchema = refineSchema(
    ClaimObject,
    'ScovaClaim',
    (value) =>
        (value.kind !== 'fact' || value.evidenceIds.length > 0) &&
        (value.kind !== 'model_answer' || value.evidenceIds.length === 0),
);
export const ChangeKindSchema = Type.Union(
    [
        Type.Literal('baseline'),
        Type.Literal('new'),
        Type.Literal('duplicate'),
        Type.Literal('duplicate_candidate'),
        Type.Literal('changed'),
        Type.Literal('non_material'),
        Type.Literal('uncertain'),
    ],
    { description: '基线、新增、重复、疑似转载、实质变化、非实质变化或待核验' },
);
const ChangeObject = Type.Object(
    {
        id: UuidSchema,
        sourceId: UuidSchema,
        kind: ChangeKindSchema,
        factKey: NonEmptyTextSchema,
        oldValue: Type.Union([NonEmptyTextSchema, Type.Null()]),
        newValue: Type.Union([NonEmptyTextSchema, Type.Null()]),
        oldEvidenceIds: Type.Array(UuidSchema, {
            uniqueItems: true,
            description: '旧值证据，来自合法基线',
        }),
        newEvidenceIds: Type.Array(UuidSchema, { uniqueItems: true, description: '本次观测证据' }),
        important: Type.Boolean({ description: '经确认是否为与任务相关的重要事实变化' }),
        reason: NonEmptyTextSchema,
    },
    { additionalProperties: false, description: '可解释差异，不把一次未观测到视为资料撤回' },
);
export const ChangeRecordSchema = refineSchema(ChangeObject, 'ScovaChange', (value) => {
    if (value.kind === 'changed')
        return (
            value.oldValue !== null &&
            value.newValue !== null &&
            value.oldEvidenceIds.length > 0 &&
            value.newEvidenceIds.length > 0
        );
    if (value.kind === 'new')
        return (
            value.oldValue === null &&
            value.newValue !== null &&
            value.oldEvidenceIds.length === 0 &&
            value.newEvidenceIds.length > 0
        );
    return true;
});
const ReportObject = Type.Object(
    {
        id: UuidSchema,
        runId: UuidSchema,
        taskId: UuidSchema,
        taskVersionId: UuidSchema,
        baselineRunId: Type.Union([UuidSchema, Type.Null()]),
        schemaVersion: Type.Literal(1),
        conversation: Type.Optional(
            Type.Object(
                {
                    reportId: UuidSchema,
                    questionId: UuidSchema,
                    operation: Type.Union([
                        Type.Literal('research'),
                        Type.Literal('revise'),
                        Type.Literal('merge'),
                    ]),
                },
                { additionalProperties: false },
            ),
        ),
        title: NonEmptyTextSchema,
        summary: NonEmptyTextSchema,
        format: OutputFormatSchema,
        mode: ModeSchema,
        outcome: RunOutcomeSchema,
        coverage: CoverageSchema,
        limitations: Type.Array(NonEmptyTextSchema, {
            description: '查阅限制与证据缺口，不能隐藏部分交付状态',
        }),
        claims: Type.Array(ClaimSchema, { minItems: 1, description: '至少一条有内容的结构化结论' }),
        evidence: Type.Array(EvidenceSchema, {
            description: '外部证据；仅模型自回答的报告允许为空',
        }),
        changes: Type.Array(ChangeRecordSchema),
        feedbackEffects: Type.Optional(FeedbackEffectsSchema),
        publishedAt: InstantSchema,
    },
    { additionalProperties: false, description: '包含已生成成果索引、结论及证据的不可变报告 DTO' },
);
export const ReportSchema = refineSchema(ReportObject, 'ScovaReport', (value) => {
    if (
        value.coverage.metrics &&
        Object.entries(
            researchCoverageMetrics(
                value.coverage.reportValue,
                value.claims,
                value.coverage.artifacts,
            ),
        ).some(
            ([key, expected]) =>
                JSON.stringify(Reflect.get(value.coverage.metrics!, key)) !==
                JSON.stringify(expected),
        )
    )
        return false;
    if (
        value.coverage.propositions &&
        (new Set(value.coverage.propositions.map((p) => p.claimIndex)).size !==
            value.coverage.propositions.length ||
            value.claims.some(
                (claim, i) =>
                    claim.kind !== 'insufficient' &&
                    !value.coverage.propositions!.some((p) => p.claimIndex === i),
            ))
    )
        return false;
    if (
        value.coverage.propositions?.some((p) => {
            const claim = value.claims[p.claimIndex];
            const selection = value.coverage.reportValue?.selections.find(
                (s) => s.claimIndex === p.claimIndex,
            );
            const requirements =
                value.coverage.artifacts?.flatMap((a) => a.coverage?.requirements ?? []) ?? [];
            return (
                !claim ||
                claim.kind === 'insufficient' ||
                p.conditions !== (selection?.assessment?.conditions ?? '') ||
                p.support !==
                    (claim.kind === 'model_answer'
                        ? 'none'
                        : (selection?.assessment?.support ?? 'unknown')) ||
                p.requirementIds.some(
                    (id) =>
                        !requirements.some(
                            (r) => r.id === id && r.claimIndexes.includes(p.claimIndex),
                        ),
                ) ||
                requirements.some(
                    (r) =>
                        r.claimIndexes.includes(p.claimIndex) && !p.requirementIds.includes(r.id),
                ) ||
                claim.evidenceIds.some(
                    (id) =>
                        !value.evidence.some(
                            (e) =>
                                e.id === id &&
                                p.passages.some(
                                    (span) =>
                                        e.snapshot?.contentHash === span.contentHash &&
                                        e.snapshot.selector.start === span.start &&
                                        e.snapshot.selector.end === span.end,
                                ),
                        ),
                ) ||
                p.passages.some(
                    (span) =>
                        span.end <= span.start ||
                        !value.evidence.some(
                            (e) =>
                                claim.evidenceIds.includes(e.id) &&
                                e.snapshot?.contentHash === span.contentHash &&
                                e.snapshot.selector.start === span.start &&
                                e.snapshot.selector.end === span.end,
                        ),
                )
            );
        })
    )
        return false;
    if (
        value.coverage.reportValue?.selections.some(
            (s) =>
                (s.basis === 'model_knowledge') !==
                (value.claims[s.claimIndex]?.kind === 'model_answer'),
        )
    )
        return false;
    if (!value.evidence.length && !value.claims.some((claim) => claim.kind === 'model_answer'))
        return false;
    const artifacts = value.coverage.artifacts;
    if (!validReportArtifacts(artifacts, value.claims, value.coverage.reportValue)) return false;
    if (
        artifacts &&
        (new Set(artifacts.map((artifact) => artifact.format)).size !== artifacts.length ||
            artifacts[0]?.format !== value.format ||
            artifacts.some(
                (artifact) =>
                    !artifact.claimIndexes.length ||
                    artifact.claimIndexes.some((index) => !value.claims[index]),
            ) ||
            new Set(artifacts.flatMap((artifact) => artifact.claimIndexes)).size !==
                value.claims.length ||
            new Set(artifacts.flatMap((artifact) => artifact.claimIndexes)).size !==
                artifacts.reduce((sum, artifact) => sum + artifact.claimIndexes.length, 0))
    )
        return false;
    if (value.coverage.delivery) {
        const expected = classifyReportDelivery(
            value.coverage.reportValue,
            value.claims,
            artifacts,
        );
        if (
            Object.entries(expected).some(
                ([key, item]) => Reflect.get(value.coverage.delivery!, key) !== item,
            )
        )
            return false;
    }
    if (
        value.coverage.reportValue &&
        (!validReportValueClaims(value.coverage.reportValue, value.claims.length) ||
            value.coverage.reportValue.selections.some(
                (s) =>
                    s.placement === 'main' &&
                    value.claims[s.claimIndex]?.kind !== 'model_answer' &&
                    !value.claims[s.claimIndex]?.evidenceIds.length,
            ) ||
            (value.coverage.completeness === 'complete' &&
                (value.coverage.reportValue.questions.some((q) => q.status === 'disputed') ||
                    classifyReportDelivery(value.coverage.reportValue, value.claims, artifacts)
                        .answeredQuestions !== value.coverage.reportValue.questions.length)) ||
            value.coverage.reportValue.questions.some(
                (q) =>
                    q.status === 'disputed' &&
                    !q.claimIndexes.some((index) => value.claims[index]?.kind === 'conflict'),
            ))
    )
        return false;
    if (
        value.coverage.completeness === 'partial' &&
        ['no_important_change', 'baseline'].includes(value.outcome)
    )
        return false;
    if (
        value.coverage.completeness === 'partial' &&
        value.limitations.length === 0 &&
        value.coverage.gaps.length === 0
    )
        return false;
    const ids = value.evidence.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) return false;
    const available = new Set(ids);
    return (
        value.claims.every((claim) => claim.evidenceIds.every((id) => available.has(id))) &&
        value.changes.every((change) =>
            [...change.oldEvidenceIds, ...change.newEvidenceIds].every((id) => available.has(id)),
        )
    );
});

export const ReportSummarySchema = Type.Object(
    {
        id: UuidSchema,
        runId: UuidSchema,
        taskId: UuidSchema,
        taskVersionId: UuidSchema,
        title: NonEmptyTextSchema,
        summary: NonEmptyTextSchema,
        format: OutputFormatSchema,
        mode: ModeSchema,
        outcome: RunOutcomeSchema,
        coverage: CoverageSchema,
        publishedAt: InstantSchema,
    },
    { additionalProperties: false, description: '报告历史摘要，保留模式和覆盖缺口' },
);
export const ReportListQuerySchema = Type.Object(
    { ...PageQuerySchema.properties, taskId: Type.Optional(UuidSchema) },
    { additionalProperties: false, description: '按任务筛选的报告历史分页参数' },
);
export const ReportListResponseSchema = pageSchema(ReportSummarySchema);

export const InboxItemSchema = Type.Object(
    {
        id: UuidSchema,
        reportId: UuidSchema,
        readAt: Type.Union([InstantSchema, Type.Null()], {
            description: '首次标为已读的时间，未读为空',
        }),
        createdAt: InstantSchema,
        report: ReportSummarySchema,
    },
    { additionalProperties: false, description: '一次报告交付对应的站内收件箱条目' },
);
export const InboxListQuerySchema = Type.Object(
    {
        ...PageQuerySchema.properties,
        unread: Type.Optional(
            Type.Boolean({ description: '为真时只返回未读，为假时只返回已读；省略返回全部' }),
        ),
    },
    { additionalProperties: false, description: '收件箱分页和已读状态筛选' },
);
export const InboxListResponseSchema = pageSchema(InboxItemSchema);
export const InboxPatchInputSchema = Type.Object(
    { read: Type.Boolean({ description: '标为已读或恢复未读' }) },
    { additionalProperties: false, description: '修改当前账号收件箱条目的已读状态' },
);

for (const schema of [
    EvidenceSelectorSchema,
    EvidenceSnapshotSchema,
    EvidenceSchema,
    ClaimSchema,
    ChangeRecordSchema,
    ReportSchema,
    ReportSummarySchema,
    ReportListQuerySchema,
    InboxItemSchema,
    InboxListQuerySchema,
    InboxPatchInputSchema,
])
    describeProperties(schema);
export type Evidence = Static<typeof EvidenceSchema>;
export type Claim = Static<typeof ClaimSchema>;
export type ChangeRecord = Static<typeof ChangeRecordSchema>;
export type Report = Static<typeof ReportSchema>;
export type ReportListQuery = Static<typeof ReportListQuerySchema>;
export type InboxListQuery = Static<typeof InboxListQuerySchema>;
export type InboxPatchInput = Static<typeof InboxPatchInputSchema>;
