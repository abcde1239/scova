import { compareCollection, collectionManifest } from './collection.ts';
import { isDeepStrictEqual } from 'node:util';
import { object } from '../../utils/guards.ts';
import { FIRECRAWL_EXTRACTION_VERSION, normalizeUrl } from '@scova/connectors';
import {
    AgentError,
    type AgentContext,
    type AgentPage,
    type ComparisonFact,
    type ComparisonManifest,
    type AgentChange,
} from '../../types.ts';

export const COMPARISON_VERSION = 'scova-comparison-v1';
const text = (v: unknown, max = 1000): v is string =>
    typeof v === 'string' && !!v.trim() && v.length <= max;
const key = (fact: ComparisonFact) =>
    `${fact.subject.normalize('NFKC').trim()}::${fact.predicate.normalize('NFKC').trim()}`;
const canonical = (url: string) => normalizeUrl(url);
function comparableValue(value: string): string {
    const clean = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const unit = /^(\d+(?:\.\d+)?)\s*(kg|g|mg)$/.exec(clean);
    if (unit) {
        const [whole, fraction = ''] = unit[1]!.split('.');
        let digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
        let exponent = ({ kg: 6, g: 3, mg: 0 }[unit[2]!] ?? 0) - fraction.length;
        if (digits === '0') exponent = 0;
        else
            while (digits.endsWith('0')) {
                digits = digits.slice(0, -1);
                exponent++;
            }
        return `mass-mg:${digits}e${exponent}`;
    }
    const months = [
        'january',
        'february',
        'march',
        'april',
        'may',
        'june',
        'july',
        'august',
        'september',
        'october',
        'november',
        'december',
    ];
    const date = /^(?:(\d{1,2}) ([a-z]+)|([a-z]+) (\d{1,2}))(?:,? (\d{4}))?$/.exec(
        clean.toLowerCase(),
    );
    if (date) {
        const month = months.indexOf((date[2] ?? date[3])!) + 1,
            day = Number(date[1] ?? date[4]);
        if (month && day >= 1 && day <= 31)
            return `date:${date[5] ?? 'unknown-year'}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return `date:${clean}`;
    return clean;
}

export function isComparisonManifest(value: unknown): value is ComparisonManifest {
    if (
        !object(value) ||
        value.schemaVersion !== 1 ||
        !text(value.runId) ||
        !text(value.comparisonScopeHash) ||
        !['live', 'demo'].includes(String(value.mode)) ||
        !Array.isArray(value.pages) ||
        !value.pages.length ||
        value.pages.length > 20
    )
        return false;
    const ids = new Set<string>(),
        urls = new Set<string>();
    for (const page of value.pages) {
        if (
            !object(page) ||
            !text(page.pageId, 100) ||
            !text(page.url, 4096) ||
            !text(page.contentHash, 64) ||
            !/^[a-f0-9]{64}$/.test(page.contentHash) ||
            !text(page.extractorVersion, 200) ||
            (page.completeComparisonInput !== undefined &&
                (page.completeComparisonInput !== 1 ||
                    value.mode !== 'live' ||
                    value.collectionPolicy !== undefined)) ||
            !Array.isArray(page.facts) ||
            page.facts.length > 12 ||
            ids.has(page.pageId)
        )
            return false;
        let url: string;
        try {
            url = canonical(page.url);
        } catch {
            return false;
        }
        if (url !== page.url || urls.has(url)) return false;
        ids.add(page.pageId);
        urls.add(url);
        const factKeys = new Set<string>();
        for (const fact of page.facts) {
            if (
                !object(fact) ||
                !text(fact.id, 100) ||
                !text(fact.subject, 200) ||
                !text(fact.predicate, 200) ||
                !text(fact.value) ||
                !text(fact.quote, 2000) ||
                !fact.quote.includes(fact.value) ||
                !['relevant', 'excluded', 'unknown'].includes(String(fact.relevance)) ||
                !['important', 'non_material', 'unknown'].includes(String(fact.importance))
            )
                return false;
            if (fact.relation !== undefined) {
                try {
                    canonical((fact.relation as Record<string, unknown>).url as string);
                } catch {
                    return false;
                }
            }
            if (
                fact.relation !== undefined &&
                (!object(fact.relation) ||
                    !['secondary', 'revision', 'contrasting'].includes(
                        String(fact.relation.kind),
                    ) ||
                    !text(fact.relation.url, 4096) ||
                    !text(fact.relation.quote, 2000) ||
                    !fact.relation.quote.includes(fact.relation.url))
            )
                return false;
            const stable = key(fact as unknown as ComparisonFact);
            if (factKeys.has(stable)) return false;
            factKeys.add(stable);
        }
    }
    return true;
}

/** Structural and verbatim provenance checks; relevance/importance remain model judgments. */
export function validateComparisonManifest(
    value: unknown,
    context: AgentContext,
    pages: AgentPage[],
): ComparisonManifest | null {
    if (
        !isComparisonManifest(value) ||
        value.runId !== context.runId ||
        value.mode !== context.mode ||
        value.comparisonScopeHash !== context.comparisonScopeHash ||
        value.pages.length !== pages.length
    )
        return null;
    for (const entry of value.pages) {
        const page = pages.find((p) => p.id === entry.pageId);
        if (
            !page ||
            entry.url !== canonical(page.url) ||
            entry.contentHash !== page.contentHash ||
            entry.extractorVersion !== page.extractionVersion ||
            entry.facts.some(
                (fact) =>
                    !page.text.includes(fact.quote) ||
                    (fact.relation && !page.text.includes(fact.relation.quote)),
            )
        )
            return null;
    }
    if (value.collectionPolicy !== undefined) {
        if (
            value.collectionPolicy !== 1 ||
            context.config.researchMode !== 'collection' ||
            !isDeepStrictEqual(value, collectionManifest(context, pages, value))
        )
            return null;
    }
    return value;
}

export function baselineReady(context: AgentContext): boolean {
    const baseline = context.baseline;
    return !!(
        baseline &&
        baseline.status === 'ready' &&
        baseline.userId === context.userId &&
        baseline.mode === context.mode &&
        baseline.runId === context.baselineRunId &&
        baseline.comparisonScopeHash === context.comparisonScopeHash &&
        isComparisonManifest(baseline.manifest) &&
        baseline.manifest.runId === baseline.runId &&
        baseline.manifest.mode === context.mode &&
        baseline.manifest.comparisonScopeHash === context.comparisonScopeHash
    );
}

/** Recompute classifications from a validated current manifest and the frozen authorized baseline. */
export function compareResearch(
    context: AgentContext,
    pages: AgentPage[],
    value: unknown,
): { changes: AgentChange[]; gaps: string[] } {
    const manifest = validateComparisonManifest(value, context, pages);
    if (!manifest) throw new AgentError('INVALID_OUTPUT', '比较事实清单与当前采集正文不一致');
    if (manifest.collectionPolicy)
        return compareCollection(context, manifest, baselineReady(context), pages);
    const changes: AgentChange[] = [],
        gaps: string[] = [];
    const ready = baselineReady(context);
    const expectedBaseline = context.baselineRunId !== null;
    if (expectedBaseline && !ready) gaps.push('冻结基线事实清单不可用，本次不能声明无重要变化');
    const previous = ready ? context.baseline!.manifest!.pages : [];
    for (const old of previous)
        if (!manifest.pages.some((p) => p.url === old.url))
            gaps.push(`基线来源本次未观测到，不能推断撤回：${old.url}`);
    const evidenceIds = (pageId: string, fact: ComparisonFact) =>
        context
            .baseline!.evidence.filter((e) => e.pageId === pageId && e.quote.includes(fact.quote))
            .map((e) => e.id);
    for (const page of manifest.pages) {
        const current = pages.find((p) => p.id === page.pageId)!;
        const old = previous.find((p) => p.url === page.url);
        if (!page.facts.length) {
            gaps.push(`来源未提取可验证事实，不能据空清单判断无变化：${page.url}`);
            continue;
        }
        if (old && old.extractorVersion !== page.extractorVersion)
            gaps.push(`正文提取版本发生变化：${page.url}`);
        for (const fact of page.facts) {
            const emit = (
                kind: AgentChange['kind'],
                prior?: { pageId: string; fact: ComparisonFact },
                important = false,
                reason = '',
            ) => {
                const oldEvidenceIds = prior ? evidenceIds(prior.pageId, prior.fact) : [];
                if (prior && !oldEvidenceIds.length) {
                    kind = 'uncertain';
                    important = false;
                    gaps.push('基线事实缺少可访问的逐字原文证据');
                }
                changes.push({
                    kind,
                    pageId: page.pageId,
                    url: page.url,
                    factKey: key(fact),
                    oldValue: prior?.fact.value ?? null,
                    newValue: fact.value,
                    oldEvidenceIds,
                    newCitations: [{ pageId: page.pageId, quote: fact.quote }],
                    important,
                    reason,
                });
            };
            const sameFact = old?.facts.find((f) => key(f) === key(fact));
            if (fact.relevance === 'excluded' && !sameFact) {
                emit(
                    'non_material',
                    undefined,
                    false,
                    '模型判定不符合任务目标，保留排除记录且不计为新增推荐',
                );
                continue;
            }
            if (
                fact.relevance === 'unknown' ||
                fact.importance === 'unknown' ||
                current.truncated ||
                current.collection?.complete === false ||
                current.extractionVersion.startsWith('search-api/') ||
                current.extractionVersion === FIRECRAWL_EXTRACTION_VERSION ||
                (expectedBaseline && !ready) ||
                (old && old.extractorVersion !== page.extractorVersion)
            ) {
                emit('uncertain', undefined, false, '相关性、重要性、完整正文或比较基线尚未核验');
                gaps.push('存在待核验的事实比较，不能声明没有重要变化');
                continue;
            }
            // Same-source fact changes always take precedence over cross-source hashes or quotations.
            if (sameFact) {
                if (comparableValue(sameFact.value) !== comparableValue(fact.value))
                    emit(
                        fact.importance === 'non_material' ? 'non_material' : 'changed',
                        { pageId: old!.pageId, fact: sameFact },
                        fact.importance === 'important',
                        fact.importance === 'non_material'
                            ? '模型判定变化仅涉及导航等非实质信息，保留双方原文值，不作为重要事实变化'
                            : fact.relevance === 'excluded'
                              ? '同一来源事实发生变化且现在不符合目标；保留双方证据，不作为新增推荐'
                              : '同一来源的稳定事实值发生变化，重要性来自任务相关的模型判断',
                    );
                else
                    emit(
                        old!.contentHash === page.contentHash ? 'duplicate' : 'non_material',
                        { pageId: old!.pageId, fact: sameFact },
                        false,
                        '同一来源事实未变；正文指纹变化本身不构成重要事实变化',
                    );
                continue;
            }
            if (old) {
                emit(
                    'uncertain',
                    undefined,
                    false,
                    '同一来源事实键无法与基线对齐，不能把模型提取差异当成事实新增',
                );
                gaps.push('同一来源存在无法对齐的事实');
                continue;
            }
            if (!ready) {
                emit(
                    expectedBaseline ? 'uncertain' : 'baseline',
                    undefined,
                    false,
                    '首次完整事实清单用于建立比较基线',
                );
                continue;
            }
            const related =
                fact.relation && previous.find((p) => p.url === canonical(fact.relation!.url));
            const prior =
                related?.facts.find((f) => key(f) === key(fact)) ??
                (fact.relation?.kind === 'contrasting'
                    ? related?.facts.find((f) => f.predicate === fact.predicate)
                    : undefined);
            if (fact.relation?.kind === 'secondary' && related) {
                emit(
                    'duplicate_candidate',
                    prior && { pageId: related.pageId, fact: prior },
                    false,
                    '来源原文明确指向既有原始资料，作为次级来源保留，不增加独立新研究',
                );
                continue;
            }
            const repost = previous.find(
                (p) =>
                    p.contentHash === page.contentHash &&
                    p.extractorVersion === page.extractorVersion &&
                    p.facts.some((f) => key(f) === key(fact) && f.value === fact.value),
            );
            if (repost) {
                const matching = repost.facts.find(
                    (f) => key(f) === key(fact) && f.value === fact.value,
                )!;
                emit(
                    'duplicate_candidate',
                    { pageId: repost.pageId, fact: matching },
                    false,
                    '跨来源完整采集正文指纹及提取版本相同，仅标记疑似转载，不据共同事实认定来源身份',
                );
                continue;
            }
            emit(
                'new',
                undefined,
                false,
                fact.relation?.kind === 'revision'
                    ? '新增作者修订资料，保留与旧原文的修订关系'
                    : fact.relation?.kind === 'contrasting'
                      ? '新增研究呈现不同观点，不能据此断定既有研究被推翻；具体条件以双方原文为准'
                      : '新增与任务相关的原文事实，重要性仍为模型语义判断',
            );
            if (
                fact.relation?.kind === 'revision' &&
                related &&
                prior &&
                comparableValue(prior.value) !== comparableValue(fact.value)
            )
                emit(
                    'changed',
                    { pageId: related.pageId, fact: prior },
                    fact.importance === 'important',
                    '原文明确关联修订，双方证据支持更正的事实值',
                );
            if (fact.relation?.kind === 'contrasting' && related && prior)
                emit(
                    'non_material',
                    { pageId: related.pageId, fact: prior },
                    false,
                    '不同观点的原文关系，双方证据不代表旧研究已被推翻；不额外推断实验条件',
                );
            else if (fact.relation?.kind === 'contrasting')
                gaps.push('不同观点的关联缺少可对齐的双方证据，仍需查证');
            if (fact.relation && !related) gaps.push('来源关系未匹配合法冻结基线，仍需查证');
        }
        if (old)
            for (const fact of old.facts)
                if (!page.facts.some((f) => key(f) === key(fact)))
                    gaps.push('基线事实本次未再次提取，不能推断已撤回');
    }
    return { changes, gaps: [...new Set(gaps)] };
}

export const comparisonSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['pages'],
    properties: {
        pages: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['pageId', 'facts'],
                properties: {
                    pageId: { type: 'string' },
                    facts: {
                        type: 'array',
                        maxItems: 12,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: [
                                'subject',
                                'predicate',
                                'value',
                                'quote',
                                'relevance',
                                'importance',
                                'relation',
                            ],
                            properties: {
                                subject: { type: 'string', minLength: 1, maxLength: 200 },
                                predicate: { type: 'string', minLength: 1, maxLength: 200 },
                                value: { type: 'string', minLength: 1, maxLength: 1000 },
                                quote: { type: 'string', minLength: 1, maxLength: 2000 },
                                relevance: {
                                    type: 'string',
                                    enum: ['relevant', 'excluded', 'unknown'],
                                },
                                importance: {
                                    type: 'string',
                                    enum: ['important', 'non_material', 'unknown'],
                                },
                                relation: {
                                    type: ['object', 'null'],
                                    additionalProperties: false,
                                    required: ['kind', 'url', 'quote'],
                                    properties: {
                                        kind: {
                                            type: 'string',
                                            enum: ['secondary', 'revision', 'contrasting'],
                                        },
                                        url: { type: 'string' },
                                        quote: { type: 'string', maxLength: 2000 },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

export function manifestFromModel(
    value: unknown,
    context: AgentContext,
    pages: AgentPage[],
): ComparisonManifest | null {
    if (!object(value) || !Array.isArray(value.pages) || value.pages.length !== pages.length)
        return null;
    const manifest: ComparisonManifest = {
        schemaVersion: 1,
        runId: context.runId,
        comparisonScopeHash: context.comparisonScopeHash!,
        mode: context.mode,
        pages: [],
    };
    for (const [index, page] of pages.entries()) {
        const entry = value.pages.find((v) => object(v) && v.pageId === page.id);
        if (!object(entry) || !Array.isArray(entry.facts)) return null;
        manifest.pages.push({
            pageId: page.id,
            url: canonical(page.url),
            contentHash: page.contentHash,
            extractorVersion: page.extractionVersion,
            facts: entry.facts.map((fact, factIndex) => {
                const normalized = object(fact) ? { ...fact } : {};
                // Strict model output requires this key; domain manifests omit absent relations.
                if (normalized.relation === null) delete normalized.relation;
                return {
                    ...normalized,
                    id: `fact-${index}-${factIndex}`,
                } as ComparisonFact;
            }),
        });
    }
    return validateComparisonManifest(manifest, context, pages);
}
