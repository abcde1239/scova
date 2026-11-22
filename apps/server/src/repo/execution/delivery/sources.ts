import { requiredDatabaseValue } from '../../../utils/execution/database.ts';
import {
    type Run,
    type ToolCall,
    eq,
    and,
    sources as dbSources,
    sourceSnapshots as dbSourceSnapshots,
    runSources as dbRunSources,
    type DatabaseTransaction,
} from '@scova/db';
import { type AgentCandidate } from '@scova/agent-core';
import { validatePublication, type SearchResponse } from '@scova/connectors';
import { hash, invalid, output } from '../../../utils/execution/delivery.ts';

export type PageRecords = Map<
    string,
    { sourceId: string; snapshotId: string; text: string; extractor: string }
>;

/** One observation per canonical source. Do not silently attach a quote to another version. */
export async function saveSources(
    tx: DatabaseTransaction,
    run: Run,
    now: Date,
    candidate: AgentCandidate,
    successful: ToolCall[],
): Promise<PageRecords> {
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
                    ...(page.collection ? { collection: { ...page.collection } } : {}),
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
                                eq(dbSourceSnapshots.extractorVersion, page.extractionVersion),
                                eq(dbSourceSnapshots.contentHash, page.contentHash),
                            ),
                        }),
                    ),
            );
        if (snapshot.textBody !== null && snapshot.textBody !== page.text) invalid();
        if ((snapshot.metadataJson as { mode?: string }).mode !== run.mode) invalid();
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
                    ...(page.collection ? { collection: { ...page.collection } } : {}),
                    collectedAt: page.collectedAt,
                    mode: page.mode,
                    publication: page.publication ? { ...page.publication, ...publication } : null,
                    searchOrigins: successful
                        .filter((call) => call.tool === 'search')
                        .flatMap((call) => {
                            const response = output(call) as SearchResponse;
                            return response.results
                                .filter(
                                    (result) =>
                                        result.originalUrl === page.originalUrl ||
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
    return pageRecords;
}
