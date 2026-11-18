import { isDeepStrictEqual } from 'node:util';
import { COVERAGE_PASSES } from '../synthesis-batches.ts';
import { allowsKnowledge } from '../loop.ts';
import { projectModelAnswers } from '../model-answer.ts';
import { type ResearchState, object } from '../state.ts';
import { frozenRequirements, fieldConflicts } from './requirements.ts';

export function draftProjections(state: ResearchState) {
    if (!state.knowledgeFirstPolicy) return [];
    const requirements = frozenRequirements(state);
    const allowed = new Set(
        requirements
            .filter((r) => allowsKnowledge(r, state.questions) && !fieldConflicts(state, r).length)
            .map((r) => r.id),
    );
    const receipts = (state.modelDraftExtractions ?? []).flatMap((receipt) => {
        const batch = Number(receipt.operationKey.split('-')[2]);
        const ids = state.modelDraftTargets?.slice(batch * 3, batch * 3 + 3) ?? [];
        const data = receipt.response.data;
        if (
            !object(data) ||
            !Array.isArray(data.answers) ||
            data.answers.length !== ids.length ||
            data.answers.some((a) => !object(a) || !ids.includes(String(a.requirementId)))
        )
            return [];
        const answers = data.answers.filter(
            (a) => object(a) && allowed.has(String(a.requirementId)),
        );
        return answers.length
            ? [{ ...receipt, response: { ...receipt.response, data: { ...data, answers } } }]
            : [];
    });
    return projectModelAnswers(receipts, requirements);
}

export function fallbackProjections(state: ResearchState) {
    // A later failed call blocks new requests, not reconstruction of successful receipts.
    return state.modelAnswerPolicy &&
        state.ready &&
        !state.adaptiveSearchDisabled &&
        (state.synthesisAttempts >= COVERAGE_PASSES || state.answerSupplementStopped) &&
        state.searchIndex > 0
        ? projectModelAnswers(
              (state.modelAnswerExtractions ?? []).filter((receipt) => {
                  const batch = Number(receipt.operationKey.split('-')[2]);
                  const ids = state.modelAnswerTargets?.slice(batch * 3, batch * 3 + 3) ?? [];
                  const data = receipt.response.data;
                  return (
                      object(data) &&
                      Array.isArray(data.answers) &&
                      data.answers.length === ids.length &&
                      data.answers.every(
                          (answer) => object(answer) && ids.includes(String(answer.requirementId)),
                      )
                  );
              }),
              state.researchLoopPolicy
                  ? frozenRequirements(state).filter((r) =>
                        allowsKnowledge(
                            r,
                            state.questions,
                            state.knowledgeFirstPolicy ? '' : state.questions[0]?.text,
                        ),
                    )
                  : frozenRequirements(state),
          )
        : [];
}

export function modelAnswerProjections(state: ResearchState) {
    return [...draftProjections(state), ...fallbackProjections(state)];
}

export function retainedModelClaims(state: ResearchState) {
    const projected = modelAnswerProjections(state).flatMap((r) =>
        object(r.response.data) && Array.isArray(r.response.data.claims)
            ? r.response.data.claims
            : [],
    );
    return state.claims.filter(
        (c) => c.kind !== 'model_answer' || projected.some((p) => isDeepStrictEqual(p, c)),
    );
}

export function allSynthesisExtractions(state: ResearchState) {
    return [
        ...draftProjections(state),
        ...(state.synthesisExtractions ?? []),
        ...fallbackProjections(state),
    ];
}
