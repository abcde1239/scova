import { Type, type Static } from "@sinclair/typebox";
import {
  HttpUrlSchema,
  InstantSchema,
  ModeSchema,
  NonEmptyTextSchema,
  OutputFormatSchema,
  RunOutcomeSchema,
  UuidSchema,
  refineSchema,
  describeProperties,
} from "./common.ts";
import { CoverageSchema } from "./runs.ts";

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
for (const schema of [EvidenceSchema, ClaimSchema, ChangeRecordSchema, ReportSchema])
  describeProperties(schema);
export type Evidence = Static<typeof EvidenceSchema>;
export type Claim = Static<typeof ClaimSchema>;
export type ChangeRecord = Static<typeof ChangeRecordSchema>;
export type Report = Static<typeof ReportSchema>;
