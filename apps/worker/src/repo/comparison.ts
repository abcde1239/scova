import {
    type Run,
    runs as dbRuns,
    eq,
    and,
    reports as dbReports,
    type DatabaseTransaction,
} from '@scova/db';
import { createHash } from 'node:crypto';
import { isComparisonManifest, type AgentBaseline } from '@scova/agent-core';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Read only the once-frozen baseline. Missing legacy manifests fail closed, never pick latest. */
export async function loadBaseline(
    tx: DatabaseTransaction,
    run: Run,
): Promise<AgentBaseline | null> {
    if (!run.baselineRunId) return null;
    const unavailable: AgentBaseline = {
        runId: run.baselineRunId,
        userId: run.userId,
        comparisonScopeHash: run.comparisonScopeHash,
        mode: run.mode,
        status: 'unavailable',
        manifest: null,
        evidence: [],
    };
    const baseline = await tx.query.runs.findFirst({
        where: and(
            eq(dbRuns.id, run.baselineRunId),
            eq(dbRuns.userId, run.userId),
            eq(dbRuns.taskId, run.taskId),
            eq(dbRuns.comparisonScopeHash, run.comparisonScopeHash),
            eq(dbRuns.mode, run.mode),
            eq(dbRuns.status, 'succeeded'),
        ),
        with: {
            reports: {
                where: eq(dbReports.completeness, 'complete'),
                with: {
                    changes: { with: { citations: true } },
                    claims: { with: { citations: true } },
                },
            },
            sources: { with: { source: true, snapshot: true, evidence: true } },
        },
    });
    const report = baseline?.reports[0];
    if (
        !baseline ||
        !report ||
        !report.comparisonJson ||
        (baseline.coverageJson as { completeness?: string } | null)?.completeness !== 'complete'
    )
        return unavailable;
    const manifest = report.comparisonJson;
    if (!isComparisonManifest(manifest)) return unavailable;
    if (
        manifest.schemaVersion !== 1 ||
        manifest.runId !== baseline.id ||
        manifest.mode !== run.mode ||
        manifest.comparisonScopeHash !== run.comparisonScopeHash ||
        !Array.isArray(manifest.pages) ||
        manifest.pages.length > 20 ||
        new Set(manifest.pages.map((page) => page.pageId)).size !== manifest.pages.length
    )
        return unavailable;
    const cited = new Set([
        ...report.claims.flatMap((claim) => claim.citations.map((citation) => citation.evidenceId)),
        ...report.changes.flatMap((change) =>
            change.citations
                .filter((citation) => citation.side === 'new')
                .map((citation) => citation.evidenceId),
        ),
    ]);
    const evidence: AgentBaseline['evidence'] = [];
    if (
        manifest.pages.length !==
        baseline.sources.filter((entry) => entry.fetchStatus === 'succeeded').length
    )
        return unavailable;
    for (const page of manifest.pages) {
        if (
            !page ||
            typeof page.pageId !== 'string' ||
            !Array.isArray(page.facts) ||
            !page.facts.length ||
            page.facts.length > 30
        )
            return unavailable;
        const observation = baseline.sources.find(
            (entry) =>
                entry.source.canonicalUrl === page.url &&
                entry.snapshot?.contentHash === page.contentHash &&
                entry.snapshot.extractorVersion === page.extractorVersion &&
                entry.fetchStatus === 'succeeded',
        );
        const snapshot = observation?.snapshot;
        if (
            !observation ||
            !snapshot ||
            (snapshot.textBody !== null && sha(snapshot.textBody) !== snapshot.contentHash) ||
            (observation.metadataJson as { truncated?: boolean; mode?: string }).truncated !==
                false ||
            (observation.metadataJson as { mode?: string }).mode !== run.mode
        )
            return unavailable;
        for (const fact of page.facts) {
            if (
                !fact ||
                typeof fact.quote !== 'string' ||
                !fact.quote.trim() ||
                fact.quote.length > 2000 ||
                typeof fact.value !== 'string' ||
                !fact.quote.includes(fact.value)
            )
                return unavailable;
            const reference = observation.evidence.find(
                (entry) =>
                    cited.has(entry.id) &&
                    entry.runId === baseline.id &&
                    entry.userId === run.userId &&
                    entry.snapshotId === snapshot.id &&
                    entry.quote === fact.quote &&
                    entry.quoteHash === sha(entry.quote),
            );
            if (!reference) return unavailable;
            const selector = reference.selectorJson as {
                type?: string;
                start?: number;
                end?: number;
                extractorVersion?: string;
            };
            if (
                selector.type !== 'text_offset' ||
                !Number.isSafeInteger(selector.start) ||
                !Number.isSafeInteger(selector.end) ||
                selector.start! < 0 ||
                selector.end! - selector.start! !== reference.quote.length ||
                selector.extractorVersion !== page.extractorVersion ||
                (snapshot.textBody !== null &&
                    snapshot.textBody.slice(selector.start, selector.end) !== reference.quote)
            )
                return unavailable;
            evidence.push({ id: reference.id, pageId: page.pageId, quote: reference.quote });
        }
    }
    return { ...unavailable, status: 'ready', manifest: structuredClone(manifest), evidence };
}
