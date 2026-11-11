import {
    ClaimAssessmentSchema,
    parseContract,
    type ClaimAssessment,
    type ReportValue,
} from '@scova/models';
import { assessPublication, normalizeUrl } from '@scova/connectors';
import { researchWindow } from './research-context.ts';
import type { AgentClaim, AgentContext, AgentPage } from './types.ts';
import { assessmentPrompt } from './prompts.ts';

export function readAssessment(value: unknown): ClaimAssessment | undefined {
    try {
        return parseContract(ClaimAssessmentSchema, value);
    } catch {
        // Optional quality metadata must never invalidate otherwise usable content.
        return undefined;
    }
}

export function taskQuestions(context: AgentContext) {
    return [
        ...new Set([context.config.goal || context.config.topic, ...context.config.focusPoints]),
    ].map((text, index) => ({ id: `q${index}`, text }));
}

/** A configured lookup window alone does not make stable documentation a news request. */
export function requiresFreshness(context: AgentContext): boolean {
    const requested = [context.config.topic, context.config.goal, ...context.config.focusPoints]
        .join('\n')
        .split(/[，,。；;\n]|但是|但|不过|\b(?:however|but)\b/iu)
        .filter(
            (clause) =>
                !/(?:不要求|不需要|无需|不必|不关注|不追踪|不研究|not\s+(?:require|need|track)|no\s+need)[\s\S]*(?:最新|近期|最近|新变化|latest|recent|new changes)/iu.test(
                    clause,
                ),
        )
        .join(' ');
    return (
        (context.config.researchMode === undefined && !!context.comparisonScopeHash) ||
        /最新|近期|最近|本周|本月|今年|当前版本|截至|截止|何时发布|\b(?:latest|recent|current version|as of|deadline|20\d{2})\b/i.test(
            requested,
        )
    );
}

export function buildReportValue(
    context: AgentContext,
    questions: { id: string; text: string }[],
    claims: AgentClaim[],
    pages: AgentPage[],
    superseded: ReadonlySet<number> = new Set(),
): ReportValue {
    const window = researchWindow(context);
    const seen = new Set<string>();
    const selections: ReportValue['selections'] = claims.map((claim, claimIndex) => {
        const assessment = readAssessment(claim.assessment);
        const questionIds = claim.questionIds.filter((id) => questions.some((q) => q.id === id));
        const dated = claim.citations.map((c) => {
            const page = pages.find((p) => p.id === c.pageId);
            if (!page) return 'unknown';
            if (
                context.baseline?.manifest?.pages.some(
                    (p) => normalizeUrl(p.url) === normalizeUrl(page.url),
                )
            )
                return 'within';
            if (!window.start || !window.end) return 'unknown';
            const result = assessPublication(page.publication, window.start, window.end);
            return result === 'in_window' ? 'within' : result;
        });
        const timeScope = dated.some((d) => d === 'outside')
            ? 'background'
            : dated.length && dated.every((d) => d === 'within')
              ? 'within'
              : 'unknown';
        const duplicateKey = JSON.stringify([
            claim.kind,
            claim.text.normalize('NFKC').trim().replace(/\s+/g, ' '),
            [...questionIds].sort(),
            assessment?.conditions ?? '',
        ]);
        const duplicate = seen.has(duplicateKey);
        seen.add(duplicateKey);
        const omitted = duplicate || assessment?.relevance === 'unrelated';
        const main =
            !omitted &&
            !superseded.has(claimIndex) &&
            claim.kind !== 'insufficient' &&
            !claim.uncertainty?.length &&
            questionIds.length > 0 &&
            claim.citations.length > 0 &&
            assessment?.relevance === 'direct' &&
            ['direct', 'partial'].includes(assessment.support) &&
            assessment.role !== 'lead';
        return {
            claimIndex,
            questionIds,
            placement: omitted ? 'omitted' : main ? 'main' : 'reference',
            reason: duplicate
                ? '同一问题、类型和条件下的重复内容'
                : assessment?.relevance === 'unrelated'
                  ? '模型评估与任务问题无关，未选入正文'
                  : superseded.has(claimIndex)
                    ? '同一成果字段已有后续综合版本补充条件，旧表述保留为参考。'
                    : main
                      ? '直接回应问题并有材料基础；支持关系来自模型自评'
                      : '未形成有材料支撑的直接回答，保留为参考线索',
            basis: assessment ? 'model_assessment' : 'unassessed',
            timeScope,
            ...(assessment ? { assessment } : {}),
        };
    });
    return {
        version: 1,
        ...(!requiresFreshness(context) ? { timeless: true as const } : {}),
        ...(context.config.researchMode === 'collection'
            ? { researchMode: 'collection' as const }
            : {}),
        questions: questions.map((question, index) => {
            const selected = selections.filter(
                (s) => s.placement === 'main' && s.questionIds.includes(question.id),
            );
            const disputed = selected.some((s) => claims[s.claimIndex]?.kind === 'conflict');
            const supported =
                selected.length > 0 &&
                selected.every((s) => {
                    const claim = claims[s.claimIndex]!;
                    return (
                        claim.kind !== 'insufficient' &&
                        s.assessment?.support === 'direct' &&
                        !s.assessment.gap &&
                        (s.timeScope === 'within' ||
                            context.config.researchMode === 'collection' ||
                            !requiresFreshness(context))
                    );
                });
            const status = disputed
                ? 'disputed'
                : supported
                  ? 'supported'
                  : selected.length
                    ? 'provisional'
                    : 'unresolved';
            const gap = [...new Set(selected.map((s) => s.assessment?.gap).filter(Boolean))].join(
                '；',
            );
            return {
                ...question,
                priority:
                    index === 0 ||
                    /必须回答|务必回答|必答|must\s+(?:answer|address)/i.test(question.text)
                        ? 'core'
                        : 'supporting',
                status,
                claimIndexes: selected.map((s) => s.claimIndex),
                gap: (
                    gap ||
                    (status === 'unresolved'
                        ? '尚无直接回应此问题且有材料支撑的答案；相关背景或未评估观点列入参考。'
                        : status === 'disputed'
                          ? '来源说法存在差异，尚未解决分歧。'
                          : status === 'provisional'
                            ? '支持关系、时间适用性或必要条件尚未完整确认。'
                            : '')
                ).slice(0, 1000),
            };
        }),
        selections,
    };
}

export const valueAssessmentPrompt = assessmentPrompt;
