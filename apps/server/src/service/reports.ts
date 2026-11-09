import { createHash } from 'node:crypto';
import { validatePublication, describePublication } from '@scova/connectors';
import {
    EvidenceSelectorSchema,
    InboxItemSchema,
    InboxListQuerySchema,
    InboxListResponseSchema,
    InboxPatchInputSchema,
    ReportListQuerySchema,
    ReportListResponseSchema,
    ReportSchema,
    ReportSummarySchema,
    parseContract,
    type Evidence,
    type Report,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import {
    createReportRepo,
    type StoredEvidence,
    type StoredInboxItem,
    type StoredReport,
    type StoredReportSummary,
} from '@/repo/reports.ts';
import { ApiError } from '@/utils/errors.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const missing = () => new ApiError(404, 'NOT_FOUND', '资源不存在');
const invalidEvidence = () =>
    new ApiError(409, 'INVALID_REPORT_EVIDENCE', '报告引用暂不可用，请稍后重试');
const invalidCursor = () => new ApiError(400, 'INVALID_CURSOR', '分页游标无效或与查询范围不一致');
type Cursor = { id: string; time: Date };
function cursorValue(value: string | undefined, scope: string): Cursor | undefined {
    if (!value) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!uuid.test(parsed.id) || parsed.scope !== scope || typeof parsed.time !== 'string')
            throw invalidCursor();
        const time = new Date(parsed.time);
        if (!Number.isFinite(time.getTime()) || time.toISOString() !== parsed.time)
            throw invalidCursor();
        return { id: parsed.id, time };
    } catch {
        throw invalidCursor();
    }
}
function encodeCursor(id: string, time: Date, scope: string) {
    return Buffer.from(JSON.stringify({ id, time: time.toISOString(), scope })).toString(
        'base64url',
    );
}
function summary(row: StoredReportSummary) {
    return parseContract(ReportSummarySchema, {
        id: row.id,
        runId: row.runId,
        taskId: row.taskId,
        taskVersionId: row.taskVersionId,
        title: row.title,
        summary: row.summary,
        format: row.format,
        mode: row.run.mode,
        outcome: row.run.outcome,
        coverage: row.run.coverageJson,
        publishedAt: row.publishedAt.toISOString(),
    });
}
function inbox(row: StoredInboxItem) {
    return parseContract(InboxItemSchema, {
        id: row.id,
        reportId: row.reportId,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        report: summary(row.report),
    });
}
function evidence(row: StoredEvidence, report: StoredReport, expectedRunId: string): Evidence {
    const observation = row.observation;
    const snapshot = observation.snapshot;
    if (
        row.userId !== report.userId ||
        row.runId !== expectedRunId ||
        observation.userId !== report.userId ||
        observation.runId !== expectedRunId ||
        observation.fetchStatus !== 'succeeded' ||
        observation.snapshotId !== row.snapshotId ||
        observation.source.userId !== report.userId ||
        !snapshot ||
        snapshot.id !== row.snapshotId ||
        snapshot.userId !== report.userId ||
        snapshot.sourceId !== observation.sourceId ||
        !observation.fetchedUrl ||
        createHash('sha256').update(row.quote).digest('hex') !== row.quoteHash
    )
        throw invalidEvidence();
    const selector = parseContract(EvidenceSelectorSchema, row.selectorJson);
    const metadata = observation.metadataJson as Record<string, unknown>;
    const publication = validatePublication(metadata?.publication);
    const dates = describePublication(metadata?.publication);
    const dateSummary = ({
        earliest: _earliest,
        latest: _latest,
        ...date
    }: typeof dates.published) => date;
    if (
        selector.extractorVersion !== snapshot.extractorVersion ||
        selector.end - selector.start !== row.quote.length ||
        !metadata ||
        metadata.mode !== report.run.mode ||
        typeof metadata.truncated !== 'boolean'
    )
        throw invalidEvidence();
    return {
        id: row.id,
        sourceId: observation.sourceId,
        snapshotId: snapshot.id,
        url: observation.requestedUrl,
        title: snapshot.title,
        quote: row.quote,
        location: `正文字符 ${selector.start}–${selector.end}（结束位置不含）`,
        observedAt: observation.observedAt.toISOString(),
        snapshot: {
            originalUrl: observation.requestedUrl,
            fetchedUrl: observation.fetchedUrl,
            canonicalUrl: observation.source.canonicalUrl,
            contentHash: snapshot.contentHash,
            extractorVersion: snapshot.extractorVersion,
            publishedAt: publication.instant,
            ...(metadata?.publication
                ? {
                      sourceDates: {
                          published: dateSummary(dates.published),
                          modified: dateSummary(dates.modified),
                      },
                  }
                : {}),
            truncated: metadata.truncated,
            selector,
        },
    };
}
function detail(row: StoredReport): Report {
    try {
        const coverage = summary(row).coverage;
        if (
            row.completeness !== coverage.completeness ||
            (row.completeness === 'complete'
                ? row.run.status !== 'succeeded'
                : row.run.status !== 'partial')
        )
            throw invalidEvidence();
        if (
            row.changes.some((change) =>
                change.citations.some((citation) => citation.side === 'old'),
            )
        ) {
            const baseline = row.baseline;
            const baselineCoverage = baseline?.coverageJson as Record<string, unknown> | null;
            if (
                !baseline ||
                baseline.id !== row.run.baselineRunId ||
                baseline.userId !== row.userId ||
                baseline.taskId !== row.taskId ||
                baseline.mode !== row.run.mode ||
                baseline.comparisonScopeHash !== row.run.comparisonScopeHash ||
                baseline.status !== 'succeeded' ||
                baselineCoverage?.completeness !== 'complete'
            )
                throw invalidEvidence();
        }
        const available = new Map<string, Evidence>();
        const addEvidence = (entry: StoredEvidence, runId: string) => {
            const mapped = evidence(entry, row, runId);
            available.set(entry.id, mapped);
            return entry.id;
        };
        const claims = row.claims.map((claim) => ({
            id: claim.id,
            kind: claim.kind,
            text: claim.text,
            confidenceLabel: claim.confidenceLabel,
            evidenceIds: claim.citations.map((citation) =>
                addEvidence(citation.evidence, row.runId),
            ),
        }));
        const changes = row.changes.map((change) => ({
            id: change.id,
            sourceId: change.sourceId,
            kind: change.kind,
            factKey: change.factKey,
            oldValue: change.oldValue,
            newValue: change.newValue,
            important: change.importance === 'important',
            reason: change.reason,
            oldEvidenceIds: change.citations
                .filter((citation) => citation.side === 'old')
                .map((citation) => {
                    if (
                        !row.baselineRunId ||
                        !change.oldSourceId ||
                        !change.oldSnapshotId ||
                        citation.evidence.observation.sourceId !== change.oldSourceId ||
                        citation.evidence.snapshotId !== change.oldSnapshotId
                    )
                        throw invalidEvidence();
                    return addEvidence(citation.evidence, row.baselineRunId);
                }),
            newEvidenceIds: change.citations
                .filter((citation) => citation.side === 'new')
                .map((citation) => {
                    if (
                        !change.newSnapshotId ||
                        citation.evidence.observation.sourceId !== change.sourceId ||
                        citation.evidence.snapshotId !== change.newSnapshotId
                    )
                        throw invalidEvidence();
                    return addEvidence(citation.evidence, row.runId);
                }),
        }));
        return parseContract(ReportSchema, {
            ...summary(row),
            baselineRunId: row.baselineRunId,
            schemaVersion: row.schemaVersion,
            limitations: row.limitationsJson,
            claims,
            evidence: [...available.values()],
            changes,
            feedbackEffects: row.feedbackEffectsJson,
        });
    } catch {
        throw invalidEvidence();
    }
}

/** 报告只读；来源引用完整校验后一次返回，避免部分泄漏非法引用。 */
export function createReportService(services: ApiServices) {
    const repo = createReportRepo(services);
    return {
        async list(userId: string, input: unknown) {
            const query = parseContract(ReportListQuerySchema, input);
            if (query.taskId && !(await repo.findTask(userId, query.taskId))) throw missing();
            const scope = `reports:${query.taskId ?? 'all'}`;
            const cursor = cursorValue(query.cursor, scope);
            if (cursor) {
                const anchor = await repo.findReportAnchor(userId, cursor.id);
                if (
                    !anchor ||
                    anchor.publishedAt.getTime() !== cursor.time.getTime() ||
                    (query.taskId && anchor.taskId !== query.taskId)
                )
                    throw invalidCursor();
            }
            const limit = Math.min(query.limit ?? 50, 100);
            const rows = await repo.listReports(userId, limit + 1, query.taskId, cursor);
            const page = rows.slice(0, limit);
            const last = page.at(-1);
            return parseContract(ReportListResponseSchema, {
                items: page.map(summary),
                nextCursor:
                    rows.length > limit && last
                        ? encodeCursor(last.id, last.publishedAt, scope)
                        : null,
            });
        },
        async get(userId: string, reportId: string) {
            if (!uuid.test(reportId)) throw missing();
            const row = await repo.findReport(userId, reportId);
            if (!row) throw missing();
            return detail(row);
        },
        async inbox(userId: string, input: unknown) {
            const query = parseContract(InboxListQuerySchema, input);
            const scope = `inbox:${query.unread === undefined ? 'all' : query.unread ? 'unread' : 'read'}`;
            const cursor = cursorValue(query.cursor, scope);
            if (cursor) {
                const anchor = await repo.findInboxAnchor(userId, cursor.id);
                if (!anchor || anchor.createdAt.getTime() !== cursor.time.getTime())
                    throw invalidCursor();
            }
            const limit = Math.min(query.limit ?? 50, 100);
            const rows = await repo.listInbox(userId, limit + 1, query.unread, cursor);
            const page = rows.slice(0, limit);
            const last = page.at(-1);
            return parseContract(InboxListResponseSchema, {
                items: page.map(inbox),
                nextCursor:
                    rows.length > limit && last
                        ? encodeCursor(last.id, last.createdAt, scope)
                        : null,
            });
        },
        async patchInbox(userId: string, inboxId: string, input: unknown) {
            if (!uuid.test(inboxId)) throw missing();
            const body = parseContract(InboxPatchInputSchema, input);
            const row = await repo.setInboxRead(userId, inboxId, body.read, services.clock());
            if (!row) throw missing();
            return inbox(row);
        },
    };
}
