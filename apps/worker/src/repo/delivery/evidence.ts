import { requiredDatabaseValue } from '@/utils/database.ts';
import { type Run, evidence as dbEvidence, type DatabaseTransaction } from '@scova/db';
import { hash, invalid } from '@/utils/delivery.ts';
import { type PageRecords } from './sources.ts';

export function createEvidenceWriter(
    tx: DatabaseTransaction,
    run: Run,
    now: Date,
    pageRecords: PageRecords,
) {
    const evidence = new Map<string, string>();
    async function saveEvidence(citation: { pageId: string; quote: string }): Promise<string> {
        const page = pageRecords.get(citation.pageId);
        if (!page) return invalid();
        const start = page.text.indexOf(citation.quote);
        if (
            start < 0 ||
            !citation.quote.trim() ||
            citation.quote.length > 2000 ||
            hash(page.text.slice(start, start + citation.quote.length)) !== hash(citation.quote)
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

    return { saveEvidence, hasEvidence: () => evidence.size > 0 };
}
export type SaveEvidence = ReturnType<typeof createEvidenceWriter>['saveEvidence'];
