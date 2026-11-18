import { selectedOutputFormats } from '@scova/models';
import { isDeepStrictEqual } from 'node:util';
import { synthesisOperation } from '../../synthesis-batches.ts';
import {
    activeFieldClaims,
    mergeFieldClaims,
    pendingFieldClaims,
} from '../../../report/field-answers.ts';
import { buildReportValue } from '../../../report/value.ts';
import { isConciseBrief } from '../../../model/input.ts';
import { type AgentClaim } from '../../../types.ts';
import { type ResearchState, object } from '../../state.ts';
import { partitionClaims, retainedModelClaims } from '../../claims.ts';
import type { AgentRuntime } from '../../runtime.ts';
import { stateArtifacts } from '../../artifacts.ts';
import type { SynthesisBatch } from '../../synthesis-batches.ts';
import type { AgentModelResponse } from '../../../types.ts';

export interface SynthesisAcceptance {
    batch: SynthesisBatch | undefined;
    attempt: number;
    batchIndex: number;
    claimCapacity: number;
    batchFormats: AgentRuntime['formats'];
    batchQuestions: ResearchState['questions'];
}
export function acceptSynthesisResponse(
    rt: AgentRuntime,
    state: ResearchState,
    response: AgentModelResponse,
    options: SynthesisAcceptance,
) {
    const { context, questions, formats } = rt;
    const { batch, attempt, batchIndex, claimCapacity, batchFormats, batchQuestions } = options;
    if (state.valuePolicy && response.mode === context.mode)
        (state.synthesisExtractions ??= []).push({
            operationKey: batch ? synthesisOperation(batchIndex, attempt) : `synthesize-${attempt}`,
            response,
        });
    const checked = partitionClaims(
        response.mode === context.mode ? response.data : null,
        state,
        true,
    );
    checked.accepted = checked.accepted.filter((claim, index) => {
        const valid = batch
            ? claim.outputFormat === batch.format
            : formats.length > 1
              ? !!claim.outputFormat && formats.includes(claim.outputFormat)
              : !claim.outputFormat || formats.includes(claim.outputFormat);
        if (!valid)
            checked.issues.push({
                index,
                code: 'unselected_or_missing_format',
                questionIds: claim.questionIds,
            });
        return valid;
    });
    state.claimIssues = checked.issues;
    if (state.answerSupplement && attempt === 1 && checked.accepted.length && !batch)
        state.claims = [];
    if (state.coveragePolicy === 3) {
        const proposed = retainedModelClaims({
            ...state,
            claims: mergeFieldClaims(state.claims, checked.accepted),
        });
        const artifacts = stateArtifacts(
            context,
            state,
            proposed,
            buildReportValue(context, questions, proposed, state.pages, undefined, {
                gapKinds: !!state.gapKindPolicy,
            }),
            questions,
            true,
            true,
        );
        const active = activeFieldClaims(proposed, artifacts);
        if (state.loopQualityPolicy)
            for (const claim of pendingFieldClaims(response.data, checked.accepted, artifacts))
                if (!active.some((c) => isDeepStrictEqual(c, claim))) active.push(claim);
        if (active.length <= claimCapacity) state.claims = active;
        else
            state.claimIssues.push({
                index: 0,
                code: 'claim_capacity',
                questionIds: batchQuestions.map((q) => q.id),
            });
    }
    if (state.coveragePolicy !== 3 && batch && attempt && checked.accepted.length) {
        // A partially successful local repair may replace its own batch, but never retire
        // another batch or lose an already supported answer/standalone finding.
        const oldClaims = (state.synthesisExtractions ?? [])
            .filter((e) =>
                Array.from({ length: attempt }, (_, i) =>
                    synthesisOperation(batchIndex, i),
                ).includes(e.operationKey),
            )
            .flatMap((e) => partitionClaims(e.response.data, state, true).accepted);
        const owned = (c: AgentClaim) => oldClaims.some((old) => isDeepStrictEqual(old, c));
        const proposed = [...state.claims.filter((c) => !owned(c)), ...checked.accepted];
        const artifactsFor = (claims: AgentClaim[]) =>
            stateArtifacts(
                context,
                state,
                claims,
                buildReportValue(context, state.questions, claims, state.pages, undefined, {
                    gapKinds: !!state.gapKindPolicy,
                }),
                state.questions,
                (state.coveragePolicy ?? 0) >= 2,
                state.coveragePolicy === 3,
            );
        const before = artifactsFor(state.claims).flatMap((a) => a.coverage?.requirements ?? []);
        const after = artifactsFor(proposed).flatMap((a) => a.coverage?.requirements ?? []);
        const bound = new Set(before.flatMap((r) => r.claimIndexes));
        const selections = buildReportValue(
            context,
            state.questions,
            state.claims,
            state.pages,
            undefined,
            { gapKinds: !!state.gapKindPolicy },
        ).selections;
        const safe =
            proposed.length <= claimCapacity &&
            (!formats.includes('brief') ||
                isConciseBrief(
                    proposed.filter((c) => c.outputFormat === 'brief'),
                    state.pages,
                )) &&
            before.every(
                (r) =>
                    r.status !== 'supported' ||
                    after.some((n) => n.id === r.id && n.status === 'supported'),
            ) &&
            state.claims.every(
                (c, i) =>
                    !owned(c) ||
                    bound.has(i) ||
                    selections[i]?.placement !== 'main' ||
                    checked.accepted.some((n) => isDeepStrictEqual(n, c)),
            );
        if (safe) state.claims = state.claims.filter((c) => !owned(c));
        else
            state.claims = state.claims.filter(
                (c) => !owned(c) || (c.kind !== 'insufficient' && !c.uncertainty?.length),
            );
    }
    // Supported repairs take slots before unresolved leads; receipts retain both.
    for (const claim of (state.coveragePolicy === 3 ? [] : [...checked.accepted]).sort(
        (a, b) => Number(a.kind === 'insufficient') - Number(b.kind === 'insufficient'),
    )) {
        if (
            state.claims.some(
                (c) =>
                    c.kind === claim.kind &&
                    c.text === claim.text &&
                    c.outputFormat === claim.outputFormat,
            )
        )
            continue;
        const merged = [...state.claims, claim];
        if (
            merged.length <= claimCapacity &&
            (!formats.includes('brief') ||
                isConciseBrief(
                    merged.filter(
                        (item) =>
                            (item.outputFormat ?? selectedOutputFormats(context.config)[0]) ===
                            'brief',
                    ),
                    state.pages,
                ))
        )
            state.claims = merged;
        else {
            const rawClaims =
                object(response.data) && Array.isArray(response.data.claims)
                    ? response.data.claims
                    : [];
            const index = rawClaims.findIndex(
                (item: unknown) =>
                    object(item) && item.kind === claim.kind && item.text === claim.text,
            );
            state.claimIssues.push({
                index: Math.max(0, index),
                code: merged.length > claimCapacity ? 'claim_capacity' : 'brief_too_long',
                questionIds: claim.questionIds,
            });
        }
    }
    state.claimIssues = state.claimIssues.slice(0, 30);
    for (const format of batchFormats) {
        if (
            !state.claims.some(
                (claim) =>
                    (claim.outputFormat ?? selectedOutputFormats(context.config)[0]) === format,
            )
        )
            state.claimIssues.push({
                index: 0,
                code: `missing_format_${format}`,
                questionIds: [],
            });
    }
    if (state.artifactPolicy && (state.coveragePolicy || attempt === 0) && state.claims.length) {
        const previewValue = buildReportValue(
            context,
            state.questions,
            state.claims,
            state.pages,
            undefined,
            { gapKinds: !!state.gapKindPolicy },
        );
        const preview = stateArtifacts(
            context,
            state,
            state.claims,
            previewValue,
            state.questions,
            (state.coveragePolicy ?? 0) >= 2,
            state.coveragePolicy === 3,
        );
        for (const artifact of preview)
            for (const requirement of artifact.coverage?.requirements ?? [])
                if (
                    (!batch || batch.requirements.some((r) => r.id === requirement.id)) &&
                    requirement.required &&
                    (state.coveragePolicy
                        ? requirement.status !== 'supported'
                        : requirement.status === 'unknown' &&
                          previewValue.selections.some(
                              (selection) =>
                                  selection.placement === 'main' &&
                                  artifact.claimIndexes.includes(selection.claimIndex) &&
                                  requirement.questionIds.every((id) =>
                                      selection.questionIds.includes(id),
                                  ),
                          ))
                )
                    state.claimIssues.push({
                        index: 0,
                        code: 'artifact_requirement_unresolved',
                        questionIds: requirement.questionIds,
                        hint: `Artifact ${artifact.format}, frozen requirement ${requirement.id}: ${requirement.object} / ${requirement.field}. Supply only evidence-supported cell text and local claim indexes. Missing structure is repairable; missing evidence remains unknown with empty text/indexes. Never invent information or change required scope to pass coverage.`.slice(
                            0,
                            1000,
                        ),
                    });
    }
    state.claimIssues = state.claimIssues.slice(0, 30);
    if (state.claimIssues.length)
        state.gaps.push('部分结论引用或类型未通过校验，已剔除并尝试定向修复');
}
