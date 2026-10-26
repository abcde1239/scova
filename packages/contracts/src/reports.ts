import { Type, type Static } from "@sinclair/typebox";
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
} from "./common.ts";
import { CoverageSchema } from "./runs.ts";

export const EvidenceSelectorSchema = refineSchema(
  Type.Object(
    {
      type: Type.Literal("text_offset"),
      start: Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "正文起始字符偏移，含该字符",
      }),
      end: Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "正文结束字符偏移，不含该字符",
      }),
      extractorVersion: NonEmptyTextSchema,
    },
    { additionalProperties: false, description: "引用在采集正文中的字符范围" },
  ),
  "ScovaEvidenceSelector",
  (value) => value.end > value.start,
);

export const EvidenceSnapshotSchema = Type.Object(
  {
    originalUrl: HttpUrlSchema,
    fetchedUrl: HttpUrlSchema,
    canonicalUrl: HttpUrlSchema,
    contentHash: Type.String({ pattern: "^[a-f0-9]{64}$", description: "采集正文的 SHA-256 指纹" }),
    extractorVersion: NonEmptyTextSchema,
    publishedAt: Type.Union([InstantSchema, Type.Null()], {
      description: "来源发布时间，未确认时为空",
    }),
    truncated: Type.Boolean({ description: "采集正文是否发生截断" }),
    selector: EvidenceSelectorSchema,
  },
  { additionalProperties: false, description: "引用可追溯的来源快照元数据，不包含完整正文" },
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
      description: "原文段落或字符位置的可解释定位，不执行页面选择器代码",
    }),
    observedAt: InstantSchema,
    snapshot: Type.Optional(EvidenceSnapshotSchema),
  },
  { additionalProperties: false, description: "原始证据片段，来源权限和执行归属仍由领域服务校验" },
);
export const ClaimKindSchema = Type.Union(
  [
    Type.Literal("fact"),
    Type.Literal("inference"),
    Type.Literal("conflict"),
    Type.Literal("insufficient"),
  ],
  { description: "来源事实、Agent 推断、冲突证据或证据不足" },
);
const ClaimObject = Type.Object(
  {
    id: UuidSchema,
    kind: ClaimKindSchema,
    text: NonEmptyTextSchema,
    confidenceLabel: NonEmptyTextSchema,
    evidenceIds: Type.Array(UuidSchema, {
      uniqueItems: true,
      description: "引用的证据 ID，必须出现在报告可访问证据中",
    }),
  },
  { additionalProperties: false, description: "结构化结论，事实型结论至少有一条引用" },
);
export const ClaimSchema = refineSchema(
  ClaimObject,
  "ScovaClaim",
  (value) => value.kind !== "fact" || value.evidenceIds.length > 0,
);
export const ChangeKindSchema = Type.Union(
  [
    Type.Literal("baseline"),
    Type.Literal("new"),
    Type.Literal("duplicate"),
    Type.Literal("duplicate_candidate"),
    Type.Literal("changed"),
    Type.Literal("non_material"),
    Type.Literal("uncertain"),
  ],
  { description: "基线、新增、重复、疑似转载、实质变化、非实质变化或待核验" },
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
      description: "旧值证据，来自合法基线",
    }),
    newEvidenceIds: Type.Array(UuidSchema, { uniqueItems: true, description: "本次观测证据" }),
    important: Type.Boolean({ description: "经确认是否为与任务相关的重要事实变化" }),
    reason: NonEmptyTextSchema,
  },
  { additionalProperties: false, description: "可解释差异，不把一次未观测到视为资料撤回" },
);
export const ChangeRecordSchema = refineSchema(ChangeObject, "ScovaChange", (value) => {
  if (value.kind === "changed")
    return (
      value.oldValue !== null &&
      value.newValue !== null &&
      value.oldEvidenceIds.length > 0 &&
      value.newEvidenceIds.length > 0
    );
  if (value.kind === "new")
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
    title: NonEmptyTextSchema,
    summary: NonEmptyTextSchema,
    format: OutputFormatSchema,
    mode: ModeSchema,
    outcome: RunOutcomeSchema,
    coverage: CoverageSchema,
    limitations: Type.Array(NonEmptyTextSchema, {
      description: "查阅限制与证据缺口，不能隐藏部分交付状态",
    }),
    claims: Type.Array(ClaimSchema, { minItems: 1, description: "至少一条有内容的结构化结论" }),
    evidence: Type.Array(EvidenceSchema, {
      minItems: 1,
      description: "至少一条可查证证据；没有证据时不能发布报告",
    }),
    changes: Type.Array(ChangeRecordSchema),
    publishedAt: InstantSchema,
  },
  { additionalProperties: false, description: "四种展示形式共用的不可变报告 DTO" },
);
export const ReportSchema = refineSchema(ReportObject, "ScovaReport", (value) => {
  if (
    value.coverage.completeness === "partial" &&
    ["no_important_change", "baseline"].includes(value.outcome)
  )
    return false;
  if (
    value.coverage.completeness === "partial" &&
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
  { additionalProperties: false, description: "报告历史摘要，保留模式和覆盖缺口" },
);
export const ReportListQuerySchema = Type.Object(
  { ...PageQuerySchema.properties, taskId: Type.Optional(UuidSchema) },
  { additionalProperties: false, description: "按任务筛选的报告历史分页参数" },
);
export const ReportListResponseSchema = pageSchema(ReportSummarySchema);

export const InboxItemSchema = Type.Object(
  {
    id: UuidSchema,
    reportId: UuidSchema,
    readAt: Type.Union([InstantSchema, Type.Null()], {
      description: "首次标为已读的时间，未读为空",
    }),
    createdAt: InstantSchema,
    report: ReportSummarySchema,
  },
  { additionalProperties: false, description: "一次报告交付对应的站内收件箱条目" },
);
export const InboxListQuerySchema = Type.Object(
  {
    ...PageQuerySchema.properties,
    unread: Type.Optional(
      Type.Boolean({ description: "为真时只返回未读，为假时只返回已读；省略返回全部" }),
    ),
  },
  { additionalProperties: false, description: "收件箱分页和已读状态筛选" },
);
export const InboxListResponseSchema = pageSchema(InboxItemSchema);
export const InboxPatchInputSchema = Type.Object(
  { read: Type.Boolean({ description: "标为已读或恢复未读" }) },
  { additionalProperties: false, description: "修改当前账号收件箱条目的已读状态" },
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
