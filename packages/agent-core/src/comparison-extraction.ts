import { isDeepStrictEqual } from 'node:util';
import { normalizeUrl } from '@scova/connectors';
import { COMPARISON_BATCH_SIZE } from '@scova/models';
export { COMPARISON_BATCH_SIZE, comparisonOutputLimits } from '@scova/models';
import { manifestFromModel, validateComparisonManifest } from './comparison.ts';
import {
    AgentError,
    type AgentChange,
    type AgentContext,
    type AgentPage,
    type ComparisonExtraction,
    type ComparisonFact,
    type ComparisonManifest,
} from './types.ts';

export function comparisonBatches(pages: AgentPage[]) {
    return Array.from({ length: Math.ceil(pages.length / COMPARISON_BATCH_SIZE) }, (_, i) =>
        pages.slice(i * COMPARISON_BATCH_SIZE, (i + 1) * COMPARISON_BATCH_SIZE),
    );
}
export function comparisonOperation(index: number, repair = false) {
    return index === 0
        ? repair
            ? 'compare-facts-repair-v1'
            : 'compare-facts-v1'
        : `compare-facts-${repair ? 'repair-' : ''}batch-${index}-v2`;
}
const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
const shortText = (v: unknown, max: number): v is string =>
    typeof v === 'string' && !!v.trim() && v.length <= max;
const factKey = (f: Pick<ComparisonFact, 'subject' | 'predicate'>) =>
    `${f.subject.normalize('NFKC').trim()}::${f.predicate.normalize('NFKC').trim()}`;
interface Pending {
    pageId: string;
    key: string;
    value: string;
}

/** Invalid model text never becomes a verbatim citation. Valid neighbors remain independently usable. */
function partition(value: unknown, context: AgentContext, pages: AgentPage[]) {
    const facts = new Map<string, ComparisonFact[]>();
    const pending: Pending[] = [];
    const incomplete = new Set<string>();
    for (const page of pages) {
        const entries =
            record(value) && Array.isArray(value.pages)
                ? value.pages.filter((p: unknown) => record(p) && p.pageId === page.id)
                : [];
        if (
            entries.length !== 1 ||
            !record(entries[0]) ||
            !Array.isArray(entries[0].facts) ||
            entries[0].facts.length > 12
        ) {
            incomplete.add(page.id);
            continue;
        }
        const accepted: ComparisonFact[] = [];
        for (const item of entries[0].facts as unknown[]) {
            const manifest = manifestFromModel(
                { pages: [{ pageId: page.id, facts: [item] }] },
                context,
                [page],
            );
            const fact = manifest?.pages[0]?.facts[0];
            if (fact) {
                if (!accepted.some((f) => factKey(f) === factKey(fact))) accepted.push(fact);
            } else if (
                record(item) &&
                shortText(item.subject, 200) &&
                shortText(item.predicate, 200) &&
                shortText(item.value, 1000)
            ) {
                pending.push({
                    pageId: page.id,
                    key: factKey({ subject: item.subject, predicate: item.predicate }),
                    value: item.value,
                });
            } else incomplete.add(page.id);
        }
        facts.set(page.id, accepted);
    }
    return { facts, pending, incomplete };
}

export function comparisonRepairPages(
    context: AgentContext,
    pages: AgentPage[],
    response?: ComparisonExtraction['response'],
) {
    const checked = partition(
        response?.mode === context.mode ? response.data : null,
        context,
        pages,
    );
    return pages.filter(
        (p) => checked.incomplete.has(p.id) || checked.pending.some((f) => f.pageId === p.id),
    );
}

export function comparisonRepairHints(
    context: AgentContext,
    pages: AgentPage[],
    response?: ComparisonExtraction['response'],
) {
    return partition(
        response?.mode === context.mode ? response.data : null,
        context,
        pages,
    ).pending.map((f) => ({ pageId: f.pageId, factKey: f.key, unverifiedValue: f.value }));
}

/** Deterministic projection shared by checkpoints and delivery ledger verification. */
export function comparisonFromExtractions(
    context: AgentContext,
    pages: AgentPage[],
    extractions: ComparisonExtraction[],
) {
    const batches = comparisonBatches(pages);
    const allowed = new Set(
        batches.flatMap((_, i) => [comparisonOperation(i), comparisonOperation(i, true)]),
    );
    if (
        extractions.length > batches.length * 2 ||
        new Set(extractions.map((e) => e.operationKey)).size !== extractions.length ||
        extractions.some((e) => !allowed.has(e.operationKey) || e.response.mode !== context.mode)
    )
        throw new AgentError('INVALID_STATE', '比较分批记录不合法');
    if (!extractions.length)
        return {
            manifest: null,
            gaps: ['事实比较未取得模型结果，报告保留为待核实'],
            uncertain: [] as AgentChange[],
        };
    const manifest: ComparisonManifest = {
        schemaVersion: 1,
        runId: context.runId,
        mode: context.mode,
        comparisonScopeHash: context.comparisonScopeHash!,
        pages: [],
    };
    const uncertain: AgentChange[] = [];
    let incomplete = 0;
    for (const [i, batch] of batches.entries()) {
        const primary = extractions.find((e) => e.operationKey === comparisonOperation(i));
        const repair = extractions.find((e) => e.operationKey === comparisonOperation(i, true));
        const original = partition(primary?.response.data, context, batch);
        const requested = comparisonRepairPages(context, batch, primary?.response);
        const fixed = partition(repair?.response.data, context, requested);
        for (const page of batch) {
            const accepted = [...(original.facts.get(page.id) ?? [])];
            for (const fact of fixed.facts.get(page.id) ?? [])
                if (!accepted.some((f) => factKey(f) === factKey(fact))) accepted.push(fact);
            if (accepted.length > 12) {
                accepted.splice(12);
                incomplete++;
            }
            const pageIndex = pages.findIndex((p) => p.id === page.id);
            manifest.pages.push({
                pageId: page.id,
                url: normalizeUrl(page.url),
                contentHash: page.contentHash,
                extractorVersion: page.extractionVersion,
                facts: accepted.map((f, n) => ({ ...f, id: `fact-${pageIndex}-${n}` })),
            });
            if (original.incomplete.has(page.id) && (!repair || fixed.incomplete.has(page.id)))
                incomplete++;
            const unresolved = [...original.pending, ...fixed.pending].filter(
                (f) => f.pageId === page.id && !accepted.some((a) => factKey(a) === f.key),
            );
            for (const f of unresolved) {
                if (uncertain.some((c) => c.pageId === f.pageId && c.factKey === f.key)) continue;
                uncertain.push({
                    kind: 'uncertain',
                    pageId: page.id,
                    url: page.url,
                    factKey: f.key,
                    oldValue: null,
                    newValue: f.value,
                    oldEvidenceIds: [],
                    newCitations: [],
                    important: false,
                    reason: '模型提取尚无可定位的原文支撑；仅保留待核实线索，不确认新增、变化或原文事实',
                });
            }
        }
    }
    const checked = validateComparisonManifest(manifest, context, pages);
    if (!checked || !isDeepStrictEqual(checked, manifest))
        throw new AgentError('INVALID_STATE', '比较分批清单损坏');
    const gaps = [
        ...(incomplete ? [`${incomplete}个来源的比较提取尚未完成，保留其他来源结果`] : []),
        ...(uncertain.length ? [`${uncertain.length}条比较线索缺少逐字依据，已标为待核实`] : []),
    ];
    return { manifest, gaps, uncertain };
}
