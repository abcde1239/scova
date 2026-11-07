import {
    ClaimAssessmentSchema,
    parseContract,
    type ClaimAssessment,
    type ReportValue,
} from '@scova/models';
import { assessPublication, normalizeUrl } from '@scova/connectors';
import { researchWindow } from './research-context.ts';
import type { AgentClaim, AgentContext, AgentPage } from './types.ts';

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

export function buildReportValue(
    context: AgentContext,
    questions: { id: string; text: string }[],
    claims: AgentClaim[],
    pages: AgentPage[],
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
                        !s.assessment.conditions &&
                        !s.assessment.gap &&
                        s.timeScope === 'within'
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

export const valueAssessmentPrompt =
    '逐条填写assessment：relevance区分direct直接回答/background背景/unrelated无关/unknown未判断；support区分direct直接支持/partial部分支持/none不支持/unknown未判断，不能仅因quote逐字真实就认定支持。role为answer/comparison/condition/risk/lead。sourceRelation仅在材料明确时用original或secondary，否则unknown，不凭域名数量声称独立核实。reason简述判断理由；conditions列出影响结论成立的假设，gap列出关键缺证，无则空字符串。优先回答原始核心问题，再补充探索线索；不要用通用建议或背景冒充答案，不强凑数量。同义信息合并但保留条件和冲突，无法回答明确说明。assessment是自评，不是独立核实。';
