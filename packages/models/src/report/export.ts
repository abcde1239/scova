import { Type, type Static } from '@sinclair/typebox';
import {
    InstantSchema,
    ModeSchema,
    NonEmptyTextSchema,
    OutputFormatSchema,
    RunOutcomeSchema,
    UuidSchema,
    describeProperties,
    refineSchema,
} from '../common/schema.ts';
import { CoverageSchema } from '../research/runs.ts';
import { ChangeRecordSchema, ClaimSchema, EvidenceSchema } from './schema.ts';

export const REPORT_EXPORT_MAX_BYTES = 256 * 1024;
export const REPORT_MARKDOWN_MAX_BYTES = REPORT_EXPORT_MAX_BYTES;
export const REPORT_JSON_MAX_QUOTE_CHARS = 500;
export const ReportExportSchema = Type.Object(
    {
        id: UuidSchema,
        reportId: UuidSchema,
        filename: Type.String({
            description: '安全的 Markdown 文件名',
            pattern: '^scova-report-[a-f0-9-]{36}\\.md$',
        }),
        markdown: Type.String({
            description: '报告摘要、结论、缺口及证据片段',
            minLength: 1,
            maxLength: REPORT_MARKDOWN_MAX_BYTES,
        }),
        byteLength: Type.Integer({
            description: 'Markdown 的 UTF-8 字节数',
            minimum: 1,
            maximum: REPORT_MARKDOWN_MAX_BYTES,
        }),
        sha256: Type.String({ description: 'Markdown 的 SHA-256 指纹', pattern: '^[a-f0-9]{64}$' }),
        expiresAt: InstantSchema,
    },
    {
        additionalProperties: false,
        description: '账号私有的报告 Markdown 快照，不包含原始采集正文',
    },
);
export type ReportExport = Static<typeof ReportExportSchema>;

const ReportExportCitationSchema = Type.Object(
    {
        ...Type.Pick(EvidenceSchema, ['id', 'title', 'url', 'location', 'observedAt']).properties,
        quote: Type.String({ minLength: 1, maxLength: REPORT_JSON_MAX_QUOTE_CHARS }),
        quoteTruncated: Type.Boolean({ description: '是否仅导出已授权引用的开头片段' }),
    },
    { additionalProperties: false, description: '可定位的短引用' },
);

export const ReportJsonDocumentSchema = refineSchema(
    describeProperties(
        Type.Object(
            {
                schemaVersion: Type.Literal(1),
                reportId: UuidSchema,
                title: NonEmptyTextSchema,
                summary: NonEmptyTextSchema,
                publishedAt: InstantSchema,
                format: OutputFormatSchema,
                mode: ModeSchema,
                outcome: RunOutcomeSchema,
                coverage: Type.Pick(CoverageSchema, ['completeness', 'gaps'], {
                    additionalProperties: false,
                    description: '查阅完整度与覆盖缺口',
                }),
                limitations: Type.Array(NonEmptyTextSchema),
                conclusions: Type.Array(ClaimSchema, { minItems: 1, description: '结构化结论' }),
                changes: Type.Array(ChangeRecordSchema),
                citations: Type.Array(ReportExportCitationSchema, { description: '短引用列表' }),
            },
            { additionalProperties: false, description: '已交付报告的结构化 JSON 文件内容' },
        ),
    ),
    'ScovaReportJsonDocument',
    (value) => {
        const citationIds = new Set(value.citations.map(({ id }) => id));
        const resolves = (id: string) => citationIds.has(id);
        return (
            citationIds.size === value.citations.length &&
            value.conclusions.every((claim) => claim.evidenceIds.every(resolves)) &&
            value.changes.every(
                (change) =>
                    change.oldEvidenceIds.every(resolves) && change.newEvidenceIds.every(resolves),
            )
        );
    },
);
export type ReportJsonDocument = Static<typeof ReportJsonDocumentSchema>;

export const ReportJsonExportSchema = refineSchema(
    Type.Object(
        {
            ...Type.Pick(ReportExportSchema, ['id', 'reportId', 'expiresAt']).properties,
            filename: Type.String({
                description: '安全的 JSON 文件名',
                pattern: '^scova-report-[a-f0-9-]{36}\\.json$',
            }),
            document: ReportJsonDocumentSchema,
            byteLength: Type.Integer({
                description: 'JSON 文件的 UTF-8 字节数',
                minimum: 1,
                maximum: REPORT_EXPORT_MAX_BYTES,
            }),
            sha256: Type.String({
                description: 'JSON 文件的 SHA-256 指纹',
                pattern: '^[a-f0-9]{64}$',
            }),
        },
        { additionalProperties: false, description: '账号私有的报告 JSON 快照' },
    ),
    'ScovaReportJsonExport',
    (value) =>
        value.reportId === value.document.reportId &&
        value.filename === `scova-report-${value.reportId}.json`,
);
export type ReportJsonExport = Static<typeof ReportJsonExportSchema>;

export function serializeReportJson(document: ReportJsonDocument): string {
    return `${JSON.stringify(document, null, 2)}\n`;
}
