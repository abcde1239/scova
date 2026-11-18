import { collectionDateEntry } from '../collection.ts';
import { createHash } from 'node:crypto';
import { selectedOutputFormats } from '@scova/models';
import { isDeepStrictEqual } from 'node:util';
import {
    pageCollectionGaps,
    PAGE_TEXT_CHAR_LIMIT,
    validPageCollection,
    validPageLinks,
    normalizeUrl,
} from '@scova/connectors';
import { requiresFreshness } from '../../report/value.ts';
import { compareResearch, validateComparisonManifest } from '../../report/comparison/compare.ts';
import { AgentError, type AgentContext } from '../../types.ts';
import { type ResearchState, MAX_QUESTIONS, strings, allowed } from '../state.ts';
import { verifyIdentity } from '../identity.ts';
import {
    allSynthesisExtractions,
    validatedClaims,
    partitionClaims,
    deterministicClaims,
} from '../claims.ts';
import { publicationGaps, extractedComparison } from './comparison.ts';

export function prepareCandidateEvidence(
    context: AgentContext,
    state: ResearchState,
    reason?: string,
) {
    verifyIdentity(state, context);
    if (!state.pages.length && !state.modelAnswerPolicy && !state.collectionPolicy)
        throw new AgentError('NO_EVIDENCE', '没有已采集的可用正文，不能生成候选成果');
    if (
        state.collectionPolicy &&
        state.pages.some((page) => collectionDateEntry(context, page).status !== 'accepted')
    )
        throw new AgentError('INVALID_STATE', '采集正文不在已确认的日期窗口内');
    const gaps = [
        ...state.gaps,
        ...pageCollectionGaps(state.pages),
        ...(state.pages.some(
            (page) =>
                typeof page.extractionVersion === 'string' &&
                page.extractionVersion.startsWith('search-api/'),
        )
            ? ['正文来自搜索 API 的页面提取，整页覆盖未经验证，不能据此判定整页没有变化']
            : []),
        ...(!requiresFreshness(context) || context.config.researchMode === 'collection'
            ? []
            : publicationGaps(context, state.pages)),
        ...(reason ? [reason] : []),
    ];
    const extracted = extractedComparison(context, state);
    if (extracted) gaps.push(...extracted.gaps);
    const manifest =
        !reason && state.manifest
            ? validateComparisonManifest(state.manifest, context, state.pages)
            : null;
    if (!reason && state.manifest && !manifest)
        throw new AgentError('INVALID_OUTPUT', '比较事实清单损坏');
    if (!reason && extracted && !isDeepStrictEqual(extracted.manifest, manifest))
        throw new AgentError('INVALID_STATE', '比较清单与分批结果不一致');
    const comparison = manifest ? compareResearch(context, state.pages, manifest) : null;
    if (manifest && !extracted && state.pages.some((p) => p.text.length > 32_000))
        gaps.push(
            '旧比较记录缺少完整输入覆盖证明，长正文可能仅查阅前32000字符，不能据此判断无重要变化',
        );
    if (comparison && extracted) comparison.changes.push(...extracted.uncertain);
    if (comparison) gaps.push(...comparison.gaps);
    if (context.comparisonScopeHash && !manifest)
        gaps.push('本次未完成可核验事实比较，不能声明没有重要变化');
    if (
        state.pages.some(
            (page) =>
                !page.id ||
                page.mode !== context.mode ||
                page.kind !== 'read_page' ||
                typeof page.text !== 'string' ||
                !page.text.trim() ||
                page.text.length > PAGE_TEXT_CHAR_LIMIT ||
                !validPageCollection(page.collection) ||
                !validPageLinks(page.links) ||
                !allowed(context, page.url) ||
                !allowed(context, page.fetchedUrl) ||
                !strings(page.questionIds, MAX_QUESTIONS, 50) ||
                page.contentHash !== createHash('sha256').update(page.text, 'utf8').digest('hex'),
        ) ||
        new Set(state.pages.map((page) => page.id)).size !== state.pages.length
    )
        throw new AgentError('INVALID_STATE', '恢复正文的内容、来源或身份校验失败');
    const claims = validatedClaims(
        {
            claims: reason
                ? deterministicClaims(state).map((claim) => ({
                      ...claim,
                      outputFormat: selectedOutputFormats(context.config)[0],
                  }))
                : state.claims,
        },
        state,
    );
    if (!claims?.length)
        throw new AgentError('INVALID_OUTPUT', '没有可验证的结论或 checkpoint 引用损坏');
    const requestedFormats = selectedOutputFormats(context.config);
    if (
        claims.some(
            (claim) =>
                claim.outputFormat !== undefined && !requestedFormats.includes(claim.outputFormat),
        ) ||
        (requestedFormats.length > 1 && claims.some((claim) => !claim.outputFormat))
    )
        throw new AgentError('INVALID_OUTPUT', '结论不属于本次选定的交付形式');
    for (const format of requestedFormats) {
        if (
            !claims.some(
                (claim) =>
                    (claim.outputFormat ?? selectedOutputFormats(context.config)[0]) === format,
            )
        ) {
            gaps.push(`未完成所选交付形式：${format}`);
            claims.push({
                outputFormat: format,
                kind: 'insufficient',
                text: '本次未能生成该形式所需的内容，请查看查阅范围说明后再安排补充研究。',
                citations: [],
                questionIds: [],
            });
        }
    }
    if (state.valuePolicy && !reason) {
        const evaluated = allSynthesisExtractions(state).flatMap(
            (receipt) => partitionClaims(receipt.response.data, state, true).accepted,
        );
        if (
            claims.some(
                (claim) =>
                    claim.assessment && !evaluated.some((saved) => isDeepStrictEqual(saved, claim)),
            )
        )
            throw new AgentError('INVALID_STATE', '结论评估与综合成功记录不一致');
    }
    // Rebuild relationship explanations identically during execution and checkpoint delivery.
    if (manifest && !state.collectionPolicy)
        for (const page of manifest.pages)
            for (const fact of page.facts) {
                if (!fact.relation || !['secondary', 'contrasting'].includes(fact.relation.kind))
                    continue;
                const target = manifest.pages.find(
                    (entry) => entry.url === normalizeUrl(fact.relation!.url),
                );
                const primary =
                    target?.facts.find(
                        (entry) =>
                            entry.subject === fact.subject && entry.predicate === fact.predicate,
                    ) ??
                    (fact.relation.kind === 'contrasting'
                        ? target?.facts.find((entry) => entry.predicate === fact.predicate)
                        : undefined);
                if (
                    !target ||
                    !primary ||
                    (fact.relation.kind === 'secondary' && primary.value === fact.value)
                )
                    continue;
                claims.push({
                    outputFormat: requestedFormats[0],
                    kind: 'inference',
                    questionIds: [],
                    text:
                        fact.relation.kind === 'secondary'
                            ? `次级来源仍记载“${fact.value}”，其关联原文本次记载“${primary.value}”；该转载可能滞后，不作为独立新增研究。`
                            : `两份原文分别记载“${primary.value}”与“${fact.value}”；保留观点差异，不据此断定旧研究已被推翻，具体条件以双方原文为准。`,
                    citations: [
                        { pageId: page.pageId, quote: fact.quote },
                        { pageId: page.pageId, quote: fact.relation.quote },
                        { pageId: target.pageId, quote: primary.quote },
                    ],
                });
            }

    return { gaps, extracted, manifest, comparison, claims };
}
export type PreparedCandidateEvidence = ReturnType<typeof prepareCandidateEvidence>;
