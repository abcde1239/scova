import { invalidModelOutput } from '../../model/errors.ts';
import { ConnectorError } from '@scova/connectors';
import { repairableModelOutput, modelStageLimited } from '../../model/errors.ts';
import {
    conflictFingerprint,
    conflictReviewOperation,
    conflictReviewSchema,
    validConflictReview,
    conflictReviewPrompt,
    conflictReviewRepairPrompt,
} from '../conflict-review.ts';
import { requireGapKinds } from '../../evidence/support.ts';
import { gapKindPrompt } from '../../model/prompts.ts';
import { batchSynthesisSchema } from '../synthesis-batches.ts';
import { mergeFieldClaims } from '../../report/field-answers.ts';
import { evidenceLinksSchema, evidenceLinkInstructions } from '../../evidence/links.ts';
import { fieldChecksSchema } from '../loop.ts';
import { type StructuredInput, estimateModelInputTokens } from '@scova/connectors';
import { type ResearchState, object } from '../state.ts';
import {
    frozenRequirements,
    fieldConflicts,
    needsConflictReview,
    partitionClaims,
} from '../claims.ts';
import { candidate } from '../candidate.ts';
import type { AgentRuntime } from '../runtime.ts';

export function conflictReviewNode(rt: AgentRuntime) {
    const { context, deps, now, guard, synthesisSchema } = rt;
    return async (state: ResearchState): Promise<ResearchState> => {
        if (!needsConflictReview(state)) return state;
        state.ready = false;
        const pass = state.synthesisAttempts;
        const requirements = frozenRequirements(state);
        if (state.conflictReviewPass !== pass) {
            const progress = candidate(context, state);
            state.conflictReviewTargets = (progress.coverage.artifacts ?? [])
                .flatMap((a) => a.coverage?.requirements ?? [])
                .filter(
                    (r) =>
                        r.required &&
                        r.status !== 'supported' &&
                        requirements.some(
                            (p) => p.id === r.id && fieldConflicts(state, p).length > 0,
                        ),
                )
                .slice(0, 8)
                .map((r) => r.id);
            state.conflictReviewPass = pass;
            state.conflictReviewIndex = 0;
            state.conflictReviewAttempt = 0;
        }
        const index = state.conflictReviewIndex ?? 0;
        const id = state.conflictReviewTargets?.[index];
        if (!id) return state;
        const requirement = requirements.find((r) => r.id === id)!;
        const prior = fieldConflicts(state, requirement);
        const attempt = state.conflictReviewAttempt ?? 0;
        const finish = () => {
            state.conflictReviewIndex = index + 1;
            state.conflictReviewAttempt = 0;
        };
        if (
            !prior.length ||
            new Set(prior.flatMap((c) => c.citations.map((q) => JSON.stringify(q)))).size > 10
        ) {
            finish();
            return state;
        }
        const schema = batchSynthesisSchema(
            synthesisSchema,
            { format: requirement.format, requirements: [requirement], maxClaims: 1 },
            requirement.questionIds,
            [...new Set(prior.flatMap((c) => c.citations.map((q) => q.pageId)))],
            true,
        );
        // One reviewed field can be a shared obligation of several frozen questions.
        const reviewClaims = (
            schema.properties as {
                claims: { items: { properties: { questionIds: { maxItems: number } } } };
            }
        ).claims;
        reviewClaims.items.properties.questionIds.maxItems = requirement.questionIds.length;
        if (state.gapKindPolicy) requireGapKinds(schema);
        (schema.properties as Record<string, unknown>).conflictReview = conflictReviewSchema(
            requirement,
            prior,
        );
        (schema.properties as Record<string, unknown>).fieldChecks = fieldChecksSchema([id]);
        (schema.properties as Record<string, unknown>).evidenceLinks = evidenceLinksSchema(
            [...new Set(prior.flatMap((c) => c.citations.map((q) => q.pageId)))],
            requirement.questionIds,
        );
        (schema.required as string[]).push('conflictReview', 'fieldChecks', 'evidenceLinks');
        (
            (schema.properties as Record<string, unknown>).claims as Record<string, unknown>
        ).minItems = 0;
        const input: StructuredInput = {
            prompt: `${conflictReviewPrompt}\n${evidenceLinkInstructions}\nUntrusted frozen data: ${JSON.stringify({ task: { topic: context.config.topic, goal: context.config.goal }, questions: state.questions.filter((q) => requirement.questionIds.includes(q.id)), requirement, prior: prior.map((c) => ({ hash: conflictFingerprint(c), claim: c })), pages: state.pages.filter((p) => prior.some((c) => c.citations.some((q) => q.pageId === p.id))).map((p) => ({ id: p.id, title: p.title, questionIds: p.questionIds, passages: prior.flatMap((c) => c.citations.filter((q) => q.pageId === p.id).map((q) => q.quote)) })) })}\nUse outputFormat on the claim; artifacts:[{format,requirements:[{id,text,claimIndexes}],document:null}]. Include all assessment fields.${state.gapKindPolicy ? `\n${gapKindPrompt}` : ''} ${attempt ? conflictReviewRepairPrompt : ''}`,
            schema,
            maxInputTokens: Math.min(16000, context.budget.maxInputTokens),
            maxOutputTokens: Math.min(4000, context.budget.maxOutputTokens),
        };
        if (
            estimateModelInputTokens(input) > input.maxInputTokens ||
            context.deadlineAt.getTime() - now() < 15000
        ) {
            state.conflictReviewIndex = state.conflictReviewTargets!.length;
            state.notes!.push('冲突复核停止：预算或剩余时间不足，保留原冲突');
            return state;
        }
        const operationKey = conflictReviewOperation(pass, id, attempt);
        try {
            const response = await deps.tools.model(operationKey, input);
            await guard();
            if (
                response.mode !== context.mode ||
                !validConflictReview(response.data, requirement, prior)
            )
                throw invalidModelOutput('冲突复核未保留完整原文、条件或字段绑定');
            const receipt = { operationKey, response };
            (state.synthesisExtractions ??= []).push(receipt);
            const checked = partitionClaims(response.data, state, true);
            if (
                object(response.data) &&
                object(response.data.conflictReview) &&
                response.data.conflictReview.resolution === 'conditional' &&
                (checked.accepted.length !== 1 ||
                    checked.accepted[0]?.kind !== 'inference' ||
                    checked.issues.length > 0)
            ) {
                state.synthesisExtractions.pop();
                throw invalidModelOutput('条件化答案引用校验失败');
            }
            state.claims = mergeFieldClaims(state.claims, checked.accepted);
            state.notes!.push(
                checked.accepted.length
                    ? `冲突复核：${requirement.object} ${requirement.field} 按条件分别回答，保留全部引用`
                    : `冲突复核：${requirement.object} ${requirement.field} 尚未解决，保留双方并生成定向补证查询`,
            );
            finish();
        } catch (error) {
            await guard();
            if (!(error instanceof ConnectorError) || error.code === 'configuration') throw error;
            if (modelStageLimited(state, error)) {
                state.conflictReviewIndex = state.conflictReviewTargets!.length;
                state.notes!.push('冲突复核停止：执行预算或供应商额度不足');
            } else if (attempt === 0 && repairableModelOutput(error))
                state.conflictReviewAttempt = 1;
            else {
                finish();
                state.notes!.push('冲突复核失败：保留原始冲突，不以模型知识覆盖');
            }
        }
        return state;
    };
}
