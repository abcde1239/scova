import type { AgentChange, AgentContext, AgentPage, ComparisonManifest } from '../../types.ts';
import { collectionDateEntry } from '../../research/collection.ts';
import { FIRECRAWL_EXTRACTION_VERSION } from '@scova/connectors';

export function collectionManifest(
    context: AgentContext,
    pages: AgentPage[],
    manifest: ComparisonManifest,
) {
    return {
        ...manifest,
        collectionPolicy: 1 as const,
        pages: manifest.pages.map((p) => {
            const entry = collectionDateEntry(
                context,
                pages.find((page) => page.id === p.pageId)!,
            );
            return { ...p, publicationKey: `${entry.dateKind}:${entry.dateValue ?? ''}` };
        }),
    };
}

/** Collection entries are keyed by subject/field and their observed publication or update date. */
export function compareCollection(
    context: AgentContext,
    manifest: ComparisonManifest,
    ready: boolean,
    pages: AgentPage[] = [],
) {
    const changes: AgentChange[] = [],
        gaps: string[] = [];
    const expected = !!context.baselineRunId;
    const previous = ready ? context.baseline!.manifest!.pages : [];
    if (expected && !ready) gaps.push('冻结比较起点不可用，本次变化未定');
    for (const page of manifest.pages)
        for (const fact of page.facts) {
            const key = `${fact.subject.normalize('NFKC').trim()}::${fact.predicate.normalize('NFKC').trim()}`;
            const old = previous.flatMap((p) =>
                p.facts
                    .filter(
                        (f) =>
                            `${f.subject.normalize('NFKC').trim()}::${f.predicate.normalize('NFKC').trim()}` ===
                            key,
                    )
                    .map((f) => ({ page: p, fact: f })),
            );
            const dated = old.find((p) => p.page.publicationKey === page.publicationKey);
            const evidence = dated
                ? context
                      .baseline!.evidence.filter(
                          (e) =>
                              e.pageId === dated.page.pageId && e.quote.includes(dated.fact.quote),
                      )
                      .map((e) => e.id)
                : [];
            const current = pages.find((p) => p.id === page.pageId);
            const limited =
                current?.truncated ||
                current?.collection?.complete === false ||
                current?.extractionVersion.startsWith('search-api/') ||
                current?.extractionVersion === FIRECRAWL_EXTRACTION_VERSION;
            const uncertain =
                limited ||
                fact.relevance !== 'relevant' ||
                (expected && !ready) ||
                (!!dated && !evidence.length);
            const kind = uncertain
                ? 'uncertain'
                : !ready
                  ? 'baseline'
                  : !dated
                    ? 'new'
                    : dated.fact.value === fact.value
                      ? 'duplicate'
                      : 'changed';
            if (uncertain) gaps.push('采集条目的相关性或比较出处尚未核验');
            changes.push({
                kind,
                pageId: page.pageId,
                url: page.url,
                factKey: key,
                oldValue: dated?.fact.value ?? null,
                newValue: fact.value,
                oldEvidenceIds: evidence,
                newCitations: [{ pageId: page.pageId, quote: fact.quote }],
                important: kind === 'changed' && fact.importance === 'important',
                reason:
                    kind === 'new'
                        ? '新的条目键或来源日期，记为新增资料'
                        : kind === 'duplicate'
                          ? '相同条目、日期和值'
                          : kind === 'changed'
                            ? '相同条目与日期的值发生变化'
                            : kind === 'baseline'
                              ? '首次采集用于建立比较起点'
                              : '条目比较缺少可核验依据',
            });
        }
    return { changes, gaps: [...new Set(gaps)] };
}
