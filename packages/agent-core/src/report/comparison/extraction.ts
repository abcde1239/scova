import { isDeepStrictEqual } from 'node:util';
import { FIRECRAWL_EXTRACTION_VERSION, normalizeUrl } from '@scova/connectors';
import { COMPARISON_BATCH_SIZE } from '@scova/models';
import type { StructuredInput } from '@scova/connectors';
export { COMPARISON_BATCH_SIZE, comparisonOutputLimits } from '@scova/models';
import { baselineReady, manifestFromModel, validateComparisonManifest } from './compare.ts';
import { baselineEligibility } from '../../research/baseline.ts';
import {
    AgentError,
    type AgentChange,
    type AgentContext,
    type AgentPage,
    type ComparisonExtraction,
    type ComparisonFact,
    type ComparisonManifest,
    type ComparisonSourceCoverage,
    type AgentModelResponse,
} from '../../types.ts';

export function comparisonBatches(pages: AgentPage[]) {
    return Array.from({ length: Math.ceil(pages.length / COMPARISON_BATCH_SIZE) }, (_, i) =>
        pages.slice(i * COMPARISON_BATCH_SIZE, (i + 1) * COMPARISON_BATCH_SIZE),
    );
}
function hasFullPage(page: AgentPage) {
    return (
        page.kind === 'read_page' &&
        page.mode === 'live' &&
        page.truncated === false &&
        page.collection?.complete !== false &&
        !page.extractionVersion.startsWith('search-api/') &&
        page.extractionVersion !== FIRECRAWL_EXTRACTION_VERSION
    );
}

/** Preserve batch indexes and operation keys across execution, recovery and delivery. */
export function comparisonPlan(context: AgentContext, pages: AgentPage[], reusePolicy?: 1) {
    const reused = new Map<string, ComparisonFact[]>();
    const baseline = context.baseline;
    if (
        reusePolicy === 1 &&
        baseline?.coverage &&
        baselineEligibility(baseline.coverage).eligible &&
        baselineReady(context) &&
        !baseline.manifest?.collectionPolicy
    ) {
        const previous = new Map(baseline.manifest!.pages.map((page) => [page.url, page]));
        for (const page of pages) {
            if (!hasFullPage(page)) continue;
            const prior = previous.get(normalizeUrl(page.url));
            if (
                prior?.completeComparisonInput === 1 &&
                prior.contentHash === page.contentHash &&
                prior.extractorVersion === page.extractionVersion &&
                prior.facts.every(
                    (fact) =>
                        baseline.evidence.some(
                            (e) => e.pageId === prior.pageId && e.quote === fact.quote,
                        ) &&
                        page.text.includes(fact.quote) &&
                        (!fact.relation || page.text.includes(fact.relation.quote)),
                )
            )
                reused.set(page.id, prior.facts);
        }
    }
    return {
        reused,
        batches: comparisonBatches(pages).map((batch) => ({
            pages: batch,
            extract: batch.filter((page) => !reused.has(page.id)),
        })),
    };
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

/** Generated from the actual model input, never from its response text. */
export function comparisonSourceCoverage(
    input: Pick<StructuredInput, 'untrustedSources'>,
): ComparisonSourceCoverage {
    if (!Array.isArray(input.untrustedSources))
        throw new AgentError('INVALID_STATE', '比较来源输入不合法');
    return {
        version: 1,
        pages: input.untrustedSources.map((source: unknown) => {
            if (!record(source) || !shortText(source.pageId, 100))
                throw new AgentError('INVALID_STATE', '比较来源输入缺少页面身份');
            return { pageId: source.pageId, clipped: typeof source.text !== 'string' };
        }),
    };
}

/** Keep transport metadata separate from the immutable model wire response. */
export function comparisonReceipt(
    operationKey: string,
    response: AgentModelResponse,
    input: StructuredInput,
): ComparisonExtraction {
    const { sourceCoverage, ...wire } = response;
    return {
        operationKey,
        response: wire,
        ...(sourceCoverage === null
            ? {}
            : { sourceCoverage: sourceCoverage ?? comparisonSourceCoverage(input) }),
    };
}

export function isComparisonSourceCoverage(value: unknown): value is ComparisonSourceCoverage {
    return (
        record(value) &&
        value.version === 1 &&
        Array.isArray(value.pages) &&
        value.pages.length <= 20 &&
        new Set(value.pages.map((page: unknown) => (record(page) ? page.pageId : undefined)))
            .size === value.pages.length &&
        value.pages.every(
            (page: unknown) =>
                record(page) && shortText(page.pageId, 100) && typeof page.clipped === 'boolean',
        )
    );
}

/** Worker delivery uses the committed tool output to authenticate both receipt projections. */
export function comparisonReceiptMatchesOutput(
    receipt: ComparisonExtraction,
    output: unknown,
): boolean {
    if (!record(output)) return false;
    const { sourceCoverage, ...response } = output;
    return (
        (sourceCoverage === undefined || isComparisonSourceCoverage(sourceCoverage)) &&
        isDeepStrictEqual(response, receipt.response) &&
        isDeepStrictEqual(sourceCoverage, receipt.sourceCoverage)
    );
}
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
    const complete = new Set<string>();
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
        if (accepted.length === entries[0].facts.length) complete.add(page.id);
    }
    return { facts, pending, incomplete, complete };
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
    reusePolicy?: 1,
) {
    const { reused, batches } = comparisonPlan(context, pages, reusePolicy);
    const allowed = new Set(
        batches.flatMap(({ extract }, i) =>
            extract.length ? [comparisonOperation(i), comparisonOperation(i, true)] : [],
        ),
    );
    if (
        extractions.length > batches.length * 2 ||
        new Set(extractions.map((e) => e.operationKey)).size !== extractions.length ||
        extractions.some(
            (e) =>
                !allowed.has(e.operationKey) ||
                e.response.mode !== context.mode ||
                (e.sourceCoverage !== undefined && !isComparisonSourceCoverage(e.sourceCoverage)),
        )
    )
        throw new AgentError('INVALID_STATE', '比较分批记录不合法');
    if (!extractions.length && !reused.size)
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
    const coverageGaps = new Set<string>();
    let incomplete = 0;
    for (const [i, { pages: batch, extract }] of batches.entries()) {
        const primary = extractions.find((e) => e.operationKey === comparisonOperation(i));
        const repair = extractions.find((e) => e.operationKey === comparisonOperation(i, true));
        const original = partition(primary?.response.data, context, extract);
        const requested = comparisonRepairPages(context, extract, primary?.response);
        const fixed = partition(repair?.response.data, context, requested);
        for (const [receipt, expected] of [
            [primary, extract],
            [repair, requested],
        ] as const) {
            if (!receipt) continue;
            if (receipt.sourceCoverage) {
                if (
                    !isDeepStrictEqual(
                        receipt.sourceCoverage.pages.map((p) => p.pageId),
                        expected.map((p) => p.id),
                    )
                )
                    throw new AgentError('INVALID_STATE', '比较输入覆盖页面与批次不一致');
                if (receipt.sourceCoverage.pages.some((p) => p.clipped))
                    coverageGaps.add('比较输入受预算限制，仅查阅部分正文，不能据此判断无重要变化');
            } else if (expected.some((p) => p.text.length > 32_000)) {
                // Prior checkpoints sent only 32k prefixes and did not persist that coverage fact.
                coverageGaps.add(
                    '旧比较记录缺少完整输入覆盖证明，长正文可能仅查阅前32000字符，不能据此判断无重要变化',
                );
            }
        }
        for (const page of batch) {
            const prior = reused.get(page.id);
            const accepted = [...(prior ?? original.facts.get(page.id) ?? [])];
            const completeInput =
                prior ||
                (reusePolicy === 1 &&
                    accepted.length > 0 &&
                    hasFullPage(page) &&
                    original.complete.has(page.id) &&
                    primary?.sourceCoverage?.pages.some((p) => p.pageId === page.id && !p.clipped));
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
                ...(completeInput ? { completeComparisonInput: 1 as const } : {}),
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
        ...coverageGaps,
        ...(incomplete ? [`${incomplete}个来源的比较提取尚未完成，保留其他来源结果`] : []),
        ...(uncertain.length ? [`${uncertain.length}条比较线索缺少逐字依据，已标为待核实`] : []),
    ];
    return { manifest, gaps, uncertain };
}
