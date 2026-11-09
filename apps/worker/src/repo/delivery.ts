import { requiredDatabaseValue } from '@/utils/database.ts';
import { reportSummary } from '@/utils/report-summary.ts';
import {
    type DatabaseClient,
    type Run,
    type ToolCall,
    reports as dbReports,
    eq,
    and,
    taskVersions as dbTaskVersions,
    toolCalls as dbToolCalls,
    asc,
    sources as dbSources,
    sourceSnapshots as dbSourceSnapshots,
    runSources as dbRunSources,
    baselines as dbBaselines,
    evidence as dbEvidence,
    claims as dbClaims,
    claimEvidence as dbClaimEvidence,
    inArray,
    changeRecords as dbChangeRecords,
    changeEvidence as dbChangeEvidence,
    inboxItems as dbInboxItems,
    runs as dbRuns,
} from '@scova/db';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    candidateFromCheckpoint,
    deterministicPartial,
    manifestFromModel,
    type AgentCandidate,
    type AgentContext,
    type ComparisonExtraction,
} from '@scova/agent-core';
import {
    BudgetSchema,
    classifyReportDelivery,
    CoverageSchema,
    TaskConfigSchema,
    UsageSchema,
    parseContract,
    readFeedbackSnapshot,
} from '@scova/models';
import { validatePublication, type ReadPage, type SearchResponse } from '@scova/connectors';

import { appendEvent, withRunFence } from '@/repo/runs.ts';
import { loadBaseline } from '@/repo/comparison.ts';
import { createTerminalNotifications } from '@/repo/notifications.ts';
import { RunExecutionError, RunFenceError, type RunLeaseToken } from '@/utils/runs.ts';

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const invalid = (): never => {
    throw new RunExecutionError('INVALID_DELIVERY_EVIDENCE');
};
export interface DeliveryProof {
    candidate: AgentCandidate;
    deadline: boolean;
    checkpointRef?: unknown;
    research?: unknown;
}
function output(call: ToolCall): unknown {
    const ref = call.outputRef as { schemaVersion?: number; result?: unknown } | null;
    if (ref?.schemaVersion !== 1 || !ref.result) return invalid();
    return ref.result;
}
function contextFor(run: Run, config: AgentContext['config']): AgentContext {
    return {
        runId: run.id,
        userId: run.userId,
        taskVersionId: run.taskVersionId,
        mode: run.mode,
        config,
        budget: parseContract(BudgetSchema, run.budgetJson),
        usage: parseContract(UsageSchema, run.usageJson),
        startedAt: run.startedAt!,
        deadlineAt: run.deadlineAt!,
        signal: new AbortController().signal,
        assertActive: async () => undefined,
        feedback: readFeedbackSnapshot(run.feedbackSnapshotJson, run.userId, run.taskId),
    };
}
function pageBody(page: AgentCandidate['pages'][number]) {
    const { id: _id, questionIds: _questions, ...body } = page;
    return body;
}
function deadlineCandidate(context: AgentContext, calls: ToolCall[]): AgentCandidate {
    const pages = calls
        .filter((call) => call.tool === 'read' && call.status === 'succeeded')
        .map((call) => output(call) as ReadPage);
    if (!pages.length) throw new RunExecutionError('NO_EVIDENCE');
    const unique = [
        ...new Map(pages.map((page) => [`${page.url}:${page.contentHash}`, page])).values(),
    ];
    return deterministicPartial(
        context,
        unique.map((page) => ({
            ...page,
            id: `page-${hash(`${page.url}:${page.contentHash}`)}`,
            questionIds: [],
        })),
    );
}

/** All business writes share the Run fence; no provider/checkpointer I/O in this transaction. */
export function createDeliveryRepository(db: DatabaseClient) {
    async function existing(token: RunLeaseToken) {
        const report = await db.query.reports.findFirst({
            where: and(eq(dbReports.userId, token.userId), eq(dbReports.runId, token.runId)),
        });
        return report ? { reportId: report.id, reused: true } : null;
    }
    return {
        async deliver(
            token: RunLeaseToken,
            raw: DeliveryProof,
        ): Promise<{ reportId: string; reused: boolean }> {
            const already = await existing(token);
            if (already) return already;
            const proof = structuredClone(raw);
            try {
                return await withRunFence(
                    db,
                    token,
                    proof.deadline ? 'deadline_delivery' : 'work',
                    async (tx, run, now) => {
                        if (proof.deadline && (!run.deadlineAt || run.deadlineAt > now)) invalid();
                        const version = await tx.query.taskVersions.findFirst({
                            where: and(
                                eq(dbTaskVersions.id, run.taskVersionId),
                                eq(dbTaskVersions.userId, run.userId),
                                eq(dbTaskVersions.taskId, run.taskId),
                            ),
                        });
                        if (!version) return invalid();
                        const config = parseContract(
                            TaskConfigSchema,
                            run.followupConfigJson ?? version.configJson,
                        );
                        const context = contextFor(run, config);
                        context.comparisonScopeHash = run.comparisonScopeHash;
                        context.baselineRunId = run.baselineRunId;
                        context.baseline = await loadBaseline(tx, run);
                        const calls = await tx.query.toolCalls.findMany({
                            where: and(
                                eq(dbToolCalls.userId, run.userId),
                                eq(dbToolCalls.runId, run.id),
                            ),
                            orderBy: [asc(dbToolCalls.operationKey), asc(dbToolCalls.attemptNo)],
                        });
                        const successful = calls.filter(
                            (call) =>
                                call.status === 'succeeded' &&
                                call.finishedAt &&
                                call.finishedAt <= run.deadlineAt!,
                        );
                        let candidate: AgentCandidate;
                        try {
                            if (proof.deadline) candidate = deadlineCandidate(context, successful);
                            else {
                                if (
                                    !run.checkpointRef ||
                                    !isDeepStrictEqual(run.checkpointRef, proof.checkpointRef)
                                )
                                    invalid();
                                candidate = candidateFromCheckpoint(context, proof.research);
                            }
                        } catch (error) {
                            if (error instanceof RunExecutionError) throw error;
                            return invalid();
                        }
                        // A caller cannot replace claims, quotes, source metadata or coverage after validation.
                        // demoReason belongs to the explicit runtime configuration rather than graph state.
                        const supplied = structuredClone(proof.candidate);
                        if (run.mode === 'demo') {
                            if (
                                typeof supplied.demoReason !== 'string' ||
                                !supplied.demoReason.trim()
                            )
                                invalid();
                            candidate.demoReason = supplied.demoReason;
                        }
                        // Deadline coverage is rebuilt from committed usage/evidence; local counters can
                        // lag a just-committed settlement while the graph is being interrupted.
                        if (proof.deadline) supplied.coverage = candidate.coverage;
                        if (!isDeepStrictEqual(supplied, candidate)) invalid();
                        if (!candidate.pages.length || !candidate.claims.length)
                            throw new RunExecutionError('NO_EVIDENCE');
                        // Quality assessments are accepted only with this Run's immutable model receipt.
                        for (const receipt of (
                            proof.research as { synthesisExtractions?: ComparisonExtraction[] }
                        )?.synthesisExtractions ?? [])
                            if (
                                !successful.some(
                                    (call) =>
                                        call.tool === 'model' &&
                                        call.operationKey.startsWith(`${receipt.operationKey}:`) &&
                                        isDeepStrictEqual(output(call), receipt.response),
                                )
                            )
                                invalid();
                        for (const page of candidate.pages) {
                            if (
                                typeof page.title !== 'string' ||
                                page.title.length > 2000 ||
                                !Number.isFinite(Date.parse(page.collectedAt)) ||
                                new Date(page.collectedAt) > run.deadlineAt! ||
                                typeof page.extractionVersion !== 'string' ||
                                !page.extractionVersion ||
                                typeof page.truncated !== 'boolean' ||
                                page.untrusted !== true
                            )
                                invalid();
                            if (
                                !successful.some(
                                    (call) =>
                                        call.tool === 'read' &&
                                        isDeepStrictEqual(output(call), pageBody(page)),
                                )
                            )
                                invalid();
                        }
                        if (candidate.manifest) {
                            const extractions = (
                                proof.research as { comparisonExtractions?: ComparisonExtraction[] }
                            )?.comparisonExtractions;
                            if (extractions) {
                                for (const receipt of extractions) {
                                    const extraction = successful.find(
                                        (call) =>
                                            call.tool === 'model' &&
                                            call.operationKey.startsWith(
                                                `${receipt.operationKey}:`,
                                            ) &&
                                            isDeepStrictEqual(output(call), receipt.response),
                                    );
                                    if (!extraction) invalid();
                                }
                                // candidateFromCheckpoint has already rebuilt all pages, valid facts,
                                // uncertainty and coverage from these independently authenticated receipts.
                            } else {
                                const extractionKey = (
                                    proof.research as { comparisonRetried?: boolean }
                                )?.comparisonRetried
                                    ? 'compare-facts-repair-v1:'
                                    : 'compare-facts-v1:';
                                const extraction = successful.find(
                                    (call) =>
                                        call.tool === 'model' &&
                                        call.operationKey.startsWith(extractionKey),
                                );
                                // Decode the immutable wire output with the same domain rules as the Agent.
                                const manifest = extraction
                                    ? manifestFromModel(
                                          (output(extraction) as { data?: unknown }).data,
                                          context,
                                          candidate.pages,
                                      )
                                    : null;
                                if (!manifest || !isDeepStrictEqual(candidate.manifest, manifest))
                                    invalid();
                            }
                        }
                        const gaps = [...candidate.coverage.gaps];
                        const notes = [...(candidate.coverage.notes ?? [])];
                        // These checks are independent of a model/caller's completeness flag.
                        if (candidate.pages.some((page) => page.truncated))
                            gaps.push('存在已截断正文，无法保证完整查阅');
                        const unresolvedCalls = calls.filter(
                            (call) =>
                                call.status !== 'succeeded' &&
                                !successful.some(
                                    (done) =>
                                        done.tool === call.tool &&
                                        done.operationKey === call.operationKey &&
                                        done.attemptNo > call.attemptNo,
                                ),
                        );
                        if (unresolvedCalls.length) gaps.push('存在失败或结果未确认的工具调用');
                        if (
                            calls.some((call) => call.status !== 'succeeded') &&
                            !unresolvedCalls.length
                        )
                            notes.push('临时工具故障已在原预算内重试恢复，相关成功结果已核验');
                        if (!proof.deadline) {
                            const state = proof.research as {
                                queries: { query: string; questionIds: string[] }[];
                                searches: { query: { query: string }; response: unknown }[];
                                selections: { url: string; questionIds: string[] }[];
                            };
                            if (!state.queries.length || !state.searches.length)
                                gaps.push('搜索计划未完成');
                            for (const search of state.searches)
                                if (
                                    (search.response as SearchResponse).query !==
                                        search.query.query ||
                                    !successful.some(
                                        (call) =>
                                            call.tool === 'search' &&
                                            isDeepStrictEqual(output(call), search.response),
                                    )
                                )
                                    invalid();
                            for (const query of state.queries)
                                if (
                                    !state.searches.some(
                                        (entry) => entry.query.query === query.query,
                                    )
                                )
                                    gaps.push('部分计划查询未取得成功结果');
                            for (const [index, selection] of state.selections.entries())
                                if (
                                    !candidate.pages.some(
                                        (page) =>
                                            page.id === `read-${index}` &&
                                            page.originalUrl === selection.url &&
                                            isDeepStrictEqual(
                                                page.questionIds,
                                                selection.questionIds,
                                            ),
                                    )
                                )
                                    gaps.push('部分计划来源未完成正文采集');
                            for (const page of candidate.pages) {
                                const index = Number(page.id.replace(/^read-/, ''));
                                const selection = state.selections[index];
                                if (
                                    !selection ||
                                    page.originalUrl !== selection.url ||
                                    !isDeepStrictEqual(page.questionIds, selection.questionIds)
                                )
                                    invalid();
                            }
                        }
                        // Publication coverage is recomputed by candidateFromCheckpoint from page-authored facts.
                        // The current source policy still cannot certify official identity.
                        if (config.sourcePreferences.officialOnly)
                            notes.push('来源已按用户指定范围筛选；范围匹配不等于独立认证官方身份');
                        if (run.mode === 'demo')
                            gaps.push(
                                '本次执行为固定演示资料，未验证互联网事实',
                                candidate.demoReason!,
                            );
                        candidate.coverage = parseContract(CoverageSchema, {
                            ...candidate.coverage,
                            delivery: classifyReportDelivery(
                                candidate.coverage.reportValue,
                                candidate.claims,
                            ),
                            ...(notes.length ? { notes: [...new Set(notes)] } : {}),
                            gaps: [...new Set(gaps)],
                            completeness: gaps.length || proof.deadline ? 'partial' : 'complete',
                        });
                        // One observation per canonical source. Do not silently attach a quote to another version.
                        const byUrl = new Map<string, string>();
                        const pageRecords = new Map<
                            string,
                            {
                                sourceId: string;
                                snapshotId: string;
                                text: string;
                                extractor: string;
                            }
                        >();
                        for (const page of candidate.pages) {
                            const publication = validatePublication(page.publication);
                            const priorHash = byUrl.get(page.url);
                            const fingerprint = `${page.contentHash}:${page.extractionVersion}`;
                            if (priorHash && priorHash !== fingerprint) invalid();
                            byUrl.set(page.url, fingerprint);
                            const source = await tx
                                .insert(dbSources)
                                .values({
                                    userId: run.userId,
                                    canonicalUrl: page.url,
                                    canonicalUrlHash: hash(page.url),
                                })
                                .onConflictDoNothing({
                                    target: [dbSources.userId, dbSources.canonicalUrlHash],
                                })
                                .returning()
                                .then(
                                    async (rows) =>
                                        rows[0] ??
                                        requiredDatabaseValue(
                                            await tx.query.sources.findFirst({
                                                where: and(
                                                    eq(dbSources.userId, run.userId),
                                                    eq(dbSources.canonicalUrlHash, hash(page.url)),
                                                ),
                                            }),
                                        ),
                                );
                            if (source.canonicalUrl !== page.url) invalid();
                            const snapshot = await tx
                                .insert(dbSourceSnapshots)
                                .values({
                                    userId: run.userId,
                                    sourceId: source.id,
                                    contentHash: page.contentHash,
                                    extractorVersion: page.extractionVersion,
                                    title: page.title || page.url,
                                    publishedAt:
                                        publication.status === 'known' && publication.instant
                                            ? new Date(publication.instant!)
                                            : null,
                                    textBody: page.text,
                                    textExpiresAt: new Date(now.getTime() + 30 * 86400_000),
                                    metadataJson: {
                                        mode: run.mode,
                                        originalUrl: page.originalUrl,
                                        fetchedUrl: page.fetchedUrl,
                                        collectedAt: page.collectedAt,
                                        truncated: page.truncated,
                                        untrusted: true,
                                    },
                                })
                                .onConflictDoNothing({
                                    target: [
                                        dbSourceSnapshots.userId,
                                        dbSourceSnapshots.sourceId,
                                        dbSourceSnapshots.extractorVersion,
                                        dbSourceSnapshots.contentHash,
                                    ],
                                })
                                .returning()
                                .then(
                                    async (rows) =>
                                        rows[0] ??
                                        requiredDatabaseValue(
                                            await tx.query.sourceSnapshots.findFirst({
                                                where: and(
                                                    eq(dbSourceSnapshots.userId, run.userId),
                                                    eq(dbSourceSnapshots.sourceId, source.id),
                                                    eq(
                                                        dbSourceSnapshots.extractorVersion,
                                                        page.extractionVersion,
                                                    ),
                                                    eq(
                                                        dbSourceSnapshots.contentHash,
                                                        page.contentHash,
                                                    ),
                                                ),
                                            }),
                                        ),
                                );
                            if (snapshot.textBody !== null && snapshot.textBody !== page.text)
                                invalid();
                            if ((snapshot.metadataJson as { mode?: string }).mode !== run.mode)
                                invalid();
                            await tx
                                .insert(dbRunSources)
                                .values({
                                    userId: run.userId,
                                    runId: run.id,
                                    sourceId: source.id,
                                    snapshotId: snapshot.id,
                                    requestedUrl: page.originalUrl,
                                    fetchedUrl: page.fetchedUrl,
                                    observedAt: new Date(page.collectedAt),
                                    fetchStatus: 'succeeded',
                                    metadataJson: {
                                        truncated: page.truncated,
                                        collectedAt: page.collectedAt,
                                        mode: page.mode,
                                        publication: page.publication
                                            ? { ...page.publication, ...publication }
                                            : null,
                                        searchOrigins: successful
                                            .filter((call) => call.tool === 'search')
                                            .flatMap((call) => {
                                                const response = output(call) as SearchResponse;
                                                return response.results
                                                    .filter(
                                                        (result) =>
                                                            result.originalUrl ===
                                                                page.originalUrl ||
                                                            result.url === page.url,
                                                    )
                                                    .map((result) => ({
                                                        kind: 'search_snippet',
                                                        query: response.query,
                                                        originalUrl: result.originalUrl,
                                                        url: result.url,
                                                        engines: result.engines ?? [],
                                                    }));
                                            }),
                                    },
                                })
                                .onConflictDoNothing({
                                    target: [dbRunSources.runId, dbRunSources.sourceId],
                                })
                                .returning()
                                .then(
                                    async (rows) =>
                                        rows[0] ??
                                        requiredDatabaseValue(
                                            await tx.query.runSources.findFirst({
                                                where: and(
                                                    eq(dbRunSources.runId, run.id),
                                                    eq(dbRunSources.sourceId, source.id),
                                                ),
                                            }),
                                        ),
                                );
                            pageRecords.set(page.id, {
                                sourceId: source.id,
                                snapshotId: snapshot.id,
                                text: page.text,
                                extractor: page.extractionVersion,
                            });
                        }
                        const baseline = await tx.query.baselines.findFirst({
                            where: and(
                                eq(dbBaselines.userId, run.userId),
                                eq(dbBaselines.taskId, run.taskId),
                                eq(dbBaselines.comparisonScopeHash, run.comparisonScopeHash),
                            ),
                        });
                        if (
                            (baseline || run.baselineRunId) &&
                            candidate.comparison === 'not_performed'
                        ) {
                            candidate.coverage = parseContract(CoverageSchema, {
                                ...candidate.coverage,
                                completeness: 'partial',
                                gaps: [
                                    ...new Set([
                                        ...candidate.coverage.gaps,
                                        '连续比较尚未执行，不能推进已有基线',
                                    ]),
                                ],
                            });
                        }
                        if (run.baselineRunId && context.baseline?.status !== 'ready') {
                            candidate.coverage.completeness = 'partial';
                            candidate.coverage.gaps = [
                                ...new Set([
                                    ...candidate.coverage.gaps,
                                    '冻结基线的比较清单或引用不可用，未推断无变化',
                                ]),
                            ];
                        }
                        const complete = candidate.coverage.completeness === 'complete';
                        const changes = candidate.changes ?? [];
                        const outcome = !complete
                            ? 'inconclusive'
                            : !run.baselineRunId
                              ? 'baseline'
                              : changes.some(
                                      (change) => change.important && change.kind === 'changed',
                                  )
                                ? 'important_change'
                                : changes.some((change) => change.kind === 'new')
                                  ? 'new_findings'
                                  : 'no_important_change';
                        const report = await tx
                            .insert(dbReports)
                            .values({
                                userId: run.userId,
                                runId: run.id,
                                taskId: run.taskId,
                                taskVersionId: run.taskVersionId,
                                baselineRunId: run.baselineRunId,
                                title: candidate.title,
                                summary: reportSummary(
                                    candidate.claims,
                                    candidate.coverage.reportValue,
                                ),
                                format: config.outputFormat,
                                completeness: candidate.coverage.completeness,
                                limitationsJson: candidate.coverage.gaps,
                                feedbackEffectsJson: candidate.feedbackEffects ?? [],
                                comparisonJson: candidate.manifest
                                    ? JSON.parse(JSON.stringify(candidate.manifest))
                                    : undefined,
                            })
                            .returning()
                            .then((rows) => requiredDatabaseValue(rows[0]));
                        const evidence = new Map<string, string>();
                        async function saveEvidence(citation: {
                            pageId: string;
                            quote: string;
                        }): Promise<string> {
                            const page = pageRecords.get(citation.pageId);
                            if (!page) return invalid();
                            const start = page.text.indexOf(citation.quote);
                            if (
                                start < 0 ||
                                !citation.quote.trim() ||
                                citation.quote.length > 2000 ||
                                hash(page.text.slice(start, start + citation.quote.length)) !==
                                    hash(citation.quote)
                            )
                                invalid();
                            const key = `${page.snapshotId}:${hash(citation.quote)}`;
                            const previous = evidence.get(key);
                            if (previous) return previous;
                            const record = await tx
                                .insert(dbEvidence)
                                .values({
                                    userId: run.userId,
                                    runId: run.id,
                                    snapshotId: page.snapshotId,
                                    quote: citation.quote,
                                    quoteHash: hash(citation.quote),
                                    capturedAt: now,
                                    selectorJson: {
                                        type: 'text_offset',
                                        start,
                                        end: start + citation.quote.length,
                                        extractorVersion: page.extractor,
                                    },
                                })
                                .returning()
                                .then((rows) => requiredDatabaseValue(rows[0]));
                            evidence.set(key, record.id);
                            return record.id;
                        }
                        for (const page of candidate.manifest?.pages ?? [])
                            for (const fact of page.facts)
                                await saveEvidence({ pageId: page.pageId, quote: fact.quote });
                        for (const [order, item] of candidate.claims.entries()) {
                            const claim = await tx
                                .insert(dbClaims)
                                .values({
                                    userId: run.userId,
                                    taskId: run.taskId,
                                    reportId: report.id,
                                    kind: item.kind,
                                    text: item.text,
                                    order: order,
                                    confidenceLabel: item.uncertainty?.length
                                        ? `待核实：${item.uncertainty.map((code) => ({ quote_unmatched: '部分引用未能定位到原文', missing_citation: '缺少直接引用', question_scope: '引用与问题的对应关系未确认', conflict_incomplete: '冲突双方证据不齐' })[code]).join('；')}。保留模型结论供参考，不作为已核验事实`
                                        : {
                                              fact: '采集原文事实',
                                              inference:
                                                  '模型归纳与推断，引用不代表推理已经独立核实',
                                              conflict: '来源存在冲突，待核验',
                                              insufficient: '待核实：证据不足，内容仅供参考',
                                          }[item.kind],
                                })
                                .returning()
                                .then((rows) => requiredDatabaseValue(rows[0]));
                            for (const [index, citation] of item.citations.entries()) {
                                const page = pageRecords.get(citation.pageId);
                                if (!page) return invalid();
                                const start = page.text.indexOf(citation.quote);
                                if (
                                    start < 0 ||
                                    !citation.quote.trim() ||
                                    hash(page.text.slice(start, start + citation.quote.length)) !==
                                        hash(citation.quote)
                                )
                                    invalid();
                                const key = `${page.snapshotId}:${hash(citation.quote)}`;
                                let evidenceId = evidence.get(key);
                                if (!evidenceId) {
                                    const record = await tx
                                        .insert(dbEvidence)
                                        .values({
                                            userId: run.userId,
                                            runId: run.id,
                                            snapshotId: page.snapshotId,
                                            quote: citation.quote,
                                            quoteHash: hash(citation.quote),
                                            selectorJson: {
                                                type: 'text_offset',
                                                start,
                                                end: start + citation.quote.length,
                                                extractorVersion: page.extractor,
                                            },
                                            capturedAt: now,
                                        })
                                        .returning()
                                        .then((rows) => requiredDatabaseValue(rows[0]));
                                    evidenceId = record.id;
                                    evidence.set(key, evidenceId);
                                }
                                await tx
                                    .insert(dbClaimEvidence)
                                    .values({
                                        userId: run.userId,
                                        claimId: claim.id,
                                        evidenceId: evidenceId,
                                        relation:
                                            item.kind === 'conflict' && index > 0
                                                ? 'contradicts'
                                                : 'supports',
                                    })
                                    .onConflictDoNothing({
                                        target: [
                                            dbClaimEvidence.claimId,
                                            dbClaimEvidence.evidenceId,
                                        ],
                                    })
                                    .returning()
                                    .then(
                                        async (rows) =>
                                            rows[0] ??
                                            requiredDatabaseValue(
                                                await tx.query.claimEvidence.findFirst({
                                                    where: and(
                                                        eq(dbClaimEvidence.claimId, claim.id),
                                                        eq(dbClaimEvidence.evidenceId, evidenceId),
                                                    ),
                                                }),
                                            ),
                                    );
                            }
                        }
                        for (const item of changes) {
                            const page = pageRecords.get(item.pageId);
                            if (!page) return invalid();
                            if (candidate.comparison !== 'completed') invalid();
                            const oldIds = [...new Set(item.oldEvidenceIds)];
                            const allowedOld = new Set(
                                context.baseline?.evidence.map((entry) => entry.id) ?? [],
                            );
                            if (oldIds.some((id) => !allowedOld.has(id))) invalid();
                            const oldEvidence = oldIds.length
                                ? await tx.query.evidence.findMany({
                                      where: and(
                                          inArray(dbEvidence.id, oldIds),
                                          eq(dbEvidence.userId, run.userId),
                                          eq(dbEvidence.runId, run.baselineRunId!),
                                      ),
                                      with: {
                                          observation: { with: { source: true, snapshot: true } },
                                      },
                                  })
                                : [];
                            if (
                                oldEvidence.length !== oldIds.length ||
                                oldEvidence.some(
                                    (entry) =>
                                        entry.observation.snapshotId !== entry.snapshotId ||
                                        entry.observation.fetchStatus !== 'succeeded',
                                )
                            )
                                invalid();
                            const oldSnapshotIds = new Set(
                                oldEvidence.map((entry) => entry.snapshotId),
                            );
                            if (oldSnapshotIds.size > 1) invalid();
                            if (
                                item.kind === 'changed' &&
                                (!oldEvidence.length ||
                                    !item.newCitations.length ||
                                    item.oldValue === null ||
                                    item.newValue === null)
                            )
                                invalid();
                            if (
                                item.kind === 'new' &&
                                (oldEvidence.length ||
                                    item.oldValue !== null ||
                                    !item.newCitations.length)
                            )
                                invalid();
                            if (item.important && item.kind !== 'changed') invalid();
                            const change = await tx
                                .insert(dbChangeRecords)
                                .values({
                                    userId: run.userId,
                                    reportId: report.id,
                                    sourceId: page.sourceId,
                                    kind: item.kind,
                                    factKey: item.factKey,
                                    oldValue: item.oldValue,
                                    newValue: item.newValue,
                                    oldSourceId: oldEvidence[0]?.observation.sourceId ?? null,
                                    oldSnapshotId: oldEvidence[0]?.snapshotId ?? null,
                                    newSnapshotId: page.snapshotId,
                                    importance: item.important ? 'important' : 'normal',
                                    reason: item.reason,
                                })
                                .returning()
                                .then((rows) => requiredDatabaseValue(rows[0]));
                            for (const old of oldEvidence)
                                await tx
                                    .insert(dbChangeEvidence)
                                    .values({
                                        userId: run.userId,
                                        changeRecordId: change.id,
                                        evidenceId: old.id,
                                        side: 'old',
                                    })
                                    .returning()
                                    .then((rows) => requiredDatabaseValue(rows[0]));
                            const newIds = new Set<string>();
                            for (const citation of item.newCitations) {
                                if (citation.pageId !== item.pageId) invalid();
                                newIds.add(await saveEvidence(citation));
                            }
                            for (const evidenceId of newIds)
                                await tx
                                    .insert(dbChangeEvidence)
                                    .values({
                                        userId: run.userId,
                                        changeRecordId: change.id,
                                        evidenceId: evidenceId,
                                        side: 'new',
                                    })
                                    .returning()
                                    .then((rows) => requiredDatabaseValue(rows[0]));
                        }
                        // An uncertain model conclusion need not have a direct citation. Keep a real
                        // source excerpt in the appendix without falsely linking it as claim support.
                        if (!evidence.size)
                            await saveEvidence({
                                pageId: candidate.pages[0]!.id,
                                quote: Array.from(candidate.pages[0]!.text).slice(0, 300).join(''),
                            });
                        await tx
                            .insert(dbInboxItems)
                            .values({ userId: run.userId, reportId: report.id })
                            .returning()
                            .then((rows) => requiredDatabaseValue(rows[0]));
                        await createTerminalNotifications(tx, run, {
                            status: complete ? 'succeeded' : 'partial',
                            outcome,
                            reportId: report.id,
                        });
                        await tx
                            .update(dbToolCalls)
                            .set({ status: 'unknown', finishedAt: now })
                            .where(
                                and(
                                    eq(dbToolCalls.userId, run.userId),
                                    eq(dbToolCalls.runId, run.id),
                                    inArray(dbToolCalls.status, ['reserved', 'running']),
                                ),
                            )
                            .returning({ id: dbToolCalls.id })
                            .then((rows) => ({ count: rows.length }));
                        await tx
                            .update(dbRuns)
                            .set({
                                status: complete ? 'succeeded' : 'partial',
                                outcome: outcome,
                                coverageJson: candidate.coverage,
                                finishedAt: now,
                                failureCode: null,
                                leaseOwner: null,
                                leaseExpiresAt: null,
                            })
                            .where(eq(dbRuns.id, run.id))
                            .returning()
                            .then((rows) => requiredDatabaseValue(rows[0]));
                        if (complete)
                            await tx
                                .insert(dbBaselines)
                                .values({
                                    userId: run.userId,
                                    taskId: run.taskId,
                                    comparisonScopeHash: run.comparisonScopeHash,
                                    completeRunId: run.id,
                                })
                                .onConflictDoUpdate({
                                    target: [
                                        dbBaselines.userId,
                                        dbBaselines.taskId,
                                        dbBaselines.comparisonScopeHash,
                                    ],
                                    set: { completeRunId: run.id },
                                })
                                .returning()
                                .then((rows) => requiredDatabaseValue(rows[0]));
                        await appendEvent(tx, run, now, {
                            type: 'coverage.updated',
                            payload: candidate.coverage,
                        });
                        await appendEvent(tx, run, now, {
                            type: 'report.published',
                            payload: {
                                reportId: report.id,
                                completeness: candidate.coverage.completeness,
                            },
                        });
                        await appendEvent(tx, run, now, {
                            type: 'run.completed',
                            payload: complete
                                ? { status: 'succeeded', outcome, reportId: report.id }
                                : {
                                      status: 'partial',
                                      outcome: 'inconclusive',
                                      reportId: report.id,
                                  },
                        });
                        return { reportId: report.id, reused: false };
                    },
                );
            } catch (error) {
                if (error instanceof RunFenceError) {
                    const committed = await existing(token);
                    if (committed) return committed;
                }
                throw error;
            }
        },
    };
}
