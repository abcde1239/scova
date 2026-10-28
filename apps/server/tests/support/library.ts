import { type DatabaseClient, type Source } from '@scova/db';
import * as tables from '@scova/db';
import { randomUUID, createHash } from 'node:crypto';
import { draftConfig } from './task-drafts.ts';
import { firstRow } from '../../src/utils/database.ts';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export async function libraryFixture(
    database: DatabaseClient,
    userId: string,
    task: { id: string; currentVersionId: string },
    options: {
        source?: Source;
        text?: string;
        title?: string;
        observedAt?: Date;
        complete?: boolean;
        snapshotId?: string;
    } = {},
) {
    const text = options.text ?? '最新小样本学习研究比较实验条件。Robotics evidence.';
    const coverage = {
        completeness: options.complete ? 'complete' : 'partial',
        searchedQueries: ['资料库测试'],
        gaps: options.complete ? [] : ['测试样例'],
        exhausted: [],
    };
    const run = await database
        .insert(tables.runs)
        .values({
            userId: userId,
            taskId: task.id,
            taskVersionId: task.currentVersionId,
            comparisonScopeHash: sha('library-scope'),
            mode: 'demo',
            trigger: 'manual',
            status: options.complete ? 'succeeded' : 'partial',
            outcome: options.complete ? 'baseline' : 'inconclusive',
            budgetJson: draftConfig().budget,
            usageJson: { searches: 1, pages: 1, inputTokens: 0, outputTokens: 0, estimated: false },
            coverageJson: coverage,
        })
        .returning()
        .then(firstRow);
    const url = 'https://example.com/library/' + randomUUID();
    const source: Source =
        options.source ??
        (await database
            .insert(tables.sources)
            .values({ userId: userId, canonicalUrl: url, canonicalUrlHash: sha(url) })
            .returning()
            .then(firstRow));
    const snapshot = await database
        .insert(tables.sourceSnapshots)
        .values({
            id: options.snapshotId,
            userId: userId,
            sourceId: source.id,
            title: options.title ?? '小样本学习资料',
            contentHash: sha(text),
            extractorVersion: 'reader-v1',
            textBody: text,
            textExpiresAt: new Date('2099-01-01T00:00:00Z'),
        })
        .returning()
        .then(firstRow);
    const observation = await database
        .insert(tables.runSources)
        .values({
            userId: userId,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: source.canonicalUrl + '?original=1',
            fetchedUrl: source.canonicalUrl,
            observedAt: options.observedAt ?? new Date(),
            fetchStatus: 'succeeded',
            metadataJson: { mode: 'demo', truncated: false },
        })
        .returning()
        .then(firstRow);
    const quote = text.slice(0, Math.min(text.length, 18));
    const evidence = await database
        .insert(tables.evidence)
        .values({
            userId: userId,
            runId: run.id,
            snapshotId: snapshot.id,
            quote: quote,
            quoteHash: sha(quote),
            selectorJson: {
                type: 'text_offset',
                start: 0,
                end: quote.length,
                extractorVersion: 'reader-v1',
            },
        })
        .returning()
        .then(firstRow);
    const manifest = {
        version: 1,
        pages: [
            {
                url: source.canonicalUrl,
                contentHash: snapshot.contentHash,
                extractorVersion: snapshot.extractorVersion,
                facts: [{ quote }],
            },
        ],
    };
    const report = await database
        .insert(tables.reports)
        .values({
            userId: userId,
            runId: run.id,
            taskId: task.id,
            taskVersionId: task.currentVersionId,
            title: '资料引用报告',
            summary: '引用原文片段',
            format: 'brief',
            completeness: options.complete ? 'complete' : 'partial',
            limitationsJson: options.complete ? [] : ['测试样例'],
            comparisonJson: manifest,
        })
        .returning()
        .then(firstRow);
    const claim = await database
        .insert(tables.claims)
        .values({
            userId: userId,
            taskId: task.id,
            reportId: report.id,
            kind: 'fact',
            text: quote,
            confidenceLabel: '原文引用',
            order: 0,
        })
        .returning()
        .then(firstRow);
    await database
        .insert(tables.claimEvidence)
        .values({
            userId: userId,
            claimId: claim.id,
            evidenceId: evidence.id,
            relation: 'supports',
        })
        .returning()
        .then(firstRow);
    return { run, source, snapshot, observation, evidence, report, quote, manifest };
}
