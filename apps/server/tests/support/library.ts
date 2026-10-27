import { randomUUID, createHash } from 'node:crypto';
import type { PrismaClient, Source } from '@scova/db';
import { draftConfig } from './task-drafts.ts';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export async function libraryFixture(
    database: PrismaClient,
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
    const run = await database.run.create({
        data: {
            userId,
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
        },
    });
    const url = 'https://example.com/library/' + randomUUID();
    const source =
        options.source ??
        (await database.source.create({
            data: { userId, canonicalUrl: url, canonicalUrlHash: sha(url) },
        }));
    const snapshot = await database.sourceSnapshot.create({
        data: {
            id: options.snapshotId,
            userId,
            sourceId: source.id,
            title: options.title ?? '小样本学习资料',
            contentHash: sha(text),
            extractorVersion: 'reader-v1',
            textBody: text,
            textExpiresAt: new Date('2099-01-01T00:00:00Z'),
        },
    });
    const observation = await database.runSource.create({
        data: {
            userId,
            runId: run.id,
            sourceId: source.id,
            snapshotId: snapshot.id,
            requestedUrl: source.canonicalUrl + '?original=1',
            fetchedUrl: source.canonicalUrl,
            observedAt: options.observedAt ?? new Date(),
            fetchStatus: 'succeeded',
            metadataJson: { mode: 'demo', truncated: false },
        },
    });
    const quote = text.slice(0, Math.min(text.length, 18));
    const evidence = await database.evidence.create({
        data: {
            userId,
            runId: run.id,
            snapshotId: snapshot.id,
            quote,
            quoteHash: sha(quote),
            selectorJson: {
                type: 'text_offset',
                start: 0,
                end: quote.length,
                extractorVersion: 'reader-v1',
            },
        },
    });
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
    const report = await database.report.create({
        data: {
            userId,
            runId: run.id,
            taskId: task.id,
            taskVersionId: task.currentVersionId,
            title: '资料引用报告',
            summary: '引用原文片段',
            format: 'brief',
            completeness: options.complete ? 'complete' : 'partial',
            limitationsJson: options.complete ? [] : ['测试样例'],
            comparisonJson: manifest,
        },
    });
    const claim = await database.claim.create({
        data: {
            userId,
            taskId: task.id,
            reportId: report.id,
            kind: 'fact',
            text: quote,
            confidenceLabel: '原文引用',
            order: 0,
        },
    });
    await database.claimEvidence.create({
        data: { userId, claimId: claim.id, evidenceId: evidence.id, relation: 'supports' },
    });
    return { run, source, snapshot, observation, evidence, report, quote, manifest };
}
