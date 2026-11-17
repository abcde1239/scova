import type { Run, ToolCall } from '@scova/db';
import { isDeepStrictEqual } from 'node:util';
import {
    candidateFromCheckpoint,
    deterministicPartial,
    manifestFromModel,
    comparisonReceiptMatchesOutput,
    searchReceiptMatchesOutput,
    type AgentCandidate,
    type AgentContext,
    type ComparisonExtraction,
} from '@scova/agent-core';
import { classifyReportDelivery, CoverageSchema, parseContract } from '@scova/models';
import { type ReadPage, type SearchResponse } from '@scova/connectors';
import { RunExecutionError } from '@/utils/runs.ts';
import { hash, invalid, output } from '@/utils/delivery.ts';

export interface DeliveryProof {
    candidate: AgentCandidate;
    deadline: boolean;
    checkpointRef?: unknown;
    research?: unknown;
}
function pageBody(page: AgentCandidate['pages'][number]) {
    const { id: _id, questionIds: _questions, ...body } = page;
    return body;
}
function deadlineCandidate(context: AgentContext, calls: ToolCall[]): AgentCandidate {
    const pages = calls
        .filter((call) => call.tool === 'read' && call.status === 'succeeded')
        .map((call) => output(call) as ReadPage);
    if (!pages.length) throw new RunExecutionError('NO_EVIDENCE');
    const unique = [
        ...new Map(pages.map((page) => [`${page.url}:${page.contentHash}`, page])).values(),
    ];
    return deterministicPartial(
        context,
        unique.map((page) => ({
            ...page,
            id: `page-${hash(`${page.url}:${page.contentHash}`)}`,
            questionIds: [],
        })),
    );
}

/** Rebuild the candidate from immutable receipts; a caller cannot alter claims, quotes or coverage. */
export function authenticateCandidate(
    run: Run,
    context: AgentContext,
    proof: DeliveryProof,
    successful: ToolCall[],
): AgentCandidate {
    let candidate: AgentCandidate;
    try {
        if (proof.deadline) candidate = deadlineCandidate(context, successful);
        else {
            if (!run.checkpointRef || !isDeepStrictEqual(run.checkpointRef, proof.checkpointRef))
                invalid();
            candidate = candidateFromCheckpoint(context, proof.research);
        }
    } catch (error) {
        if (error instanceof RunExecutionError) throw error;
        return invalid();
    }
    // A caller cannot replace claims, quotes, source metadata or coverage after validation.
    // demoReason belongs to the explicit runtime configuration rather than graph state.
    const supplied = structuredClone(proof.candidate);
    if (run.mode === 'demo') {
        if (typeof supplied.demoReason !== 'string' || !supplied.demoReason.trim()) invalid();
        candidate.demoReason = supplied.demoReason;
    }
    // Deadline coverage is rebuilt from committed usage/evidence; local counters can
    // lag a just-committed settlement while the graph is being interrupted.
    if (proof.deadline) supplied.coverage = candidate.coverage;
    if (!isDeepStrictEqual(supplied, candidate)) invalid();
    if (
        (!candidate.pages.length &&
            !candidate.claims.some((claim) => claim.kind === 'model_answer')) ||
        !candidate.claims.length
    )
        throw new RunExecutionError('NO_EVIDENCE');
    // Object/field coverage is founded on the frozen model plan, not a
    // caller-editable checkpoint projection. Removing its policy marker
    // must not hide a committed structured plan either.
    if (!proof.deadline) {
        const research = proof.research as {
            artifactPolicy?: number;
            evidencePolicy?: number;
            researchLoopPolicy?: number;
            conflictReviewPolicy?: number;
            answerCompletionPolicy?: number;
            gapKindPolicy?: number;
            knowledgeFirstPolicy?: number;
            gapLoopPolicy?: number;
            planningExtraction?: ComparisonExtraction;
        };
        // These flags are stamped by the Worker from frozen request metadata, never by the model.
        for (const call of successful) {
            if (call.tool !== 'model' || !/^plan-[01]:/.test(call.operationKey)) continue;
            const policy = (output(call) as { researchPolicy?: Record<string, unknown> })
                .researchPolicy;
            for (const name of [
                'answerCompletionPolicy',
                'gapKindPolicy',
                'knowledgeFirstPolicy',
                'gapLoopPolicy',
            ] as const)
                if (policy?.[name] !== research[name]) invalid();
        }
        // New support links cannot be reinterpreted with legacy discovery scopes.
        const committedEvidencePolicy = successful.some((call) => {
            if (
                call.tool !== 'model' ||
                !/^(?:plan-[01]|synthesize-(?:[0-9]|[1-5][0-9]|6[0-3]|batch-[0-9]+-(?:[0-9]|[1-5][0-9]|6[0-3]))):/.test(
                    call.operationKey,
                )
            )
                return false;
            const response = output(call) as { data?: Record<string, unknown> };
            return (
                !!response.data &&
                (Object.hasOwn(response.data, 'knowledgePlan') ||
                    Object.hasOwn(response.data, 'evidenceLinks'))
            );
        });
        if (committedEvidencePolicy && research.evidencePolicy !== 1) invalid();
        const committedResearchLoop = successful.some((call) => {
            if (
                call.tool !== 'model' ||
                !/^(?:plan-[01]|synthesize-(?:[0-9]|[1-5][0-9]|6[0-3]|batch-[0-9]+-(?:[0-9]|[1-5][0-9]|6[0-3]))):/.test(
                    call.operationKey,
                )
            )
                return false;
            const response = output(call) as {
                data?: { fieldChecks?: unknown; requirements?: unknown[] };
            };
            return (
                !!response.data &&
                (Object.hasOwn(response.data, 'fieldChecks') ||
                    response.data.requirements?.some(
                        (r) => !!r && typeof r === 'object' && Object.hasOwn(r, 'verification'),
                    ))
            );
        });
        if (committedResearchLoop && research.researchLoopPolicy !== 1) invalid();
        if (
            successful.some(
                (call) =>
                    call.tool === 'model' &&
                    /^conflict-review-(?:[2-9]|[1-5][0-9]|6[0-4])-[a-f0-9]{16}-[01]:/.test(
                        call.operationKey,
                    ),
            ) &&
            research.conflictReviewPolicy !== 1
        )
            invalid();
        const planning = research?.planningExtraction;
        const committedStructuredPlan = successful.some((call) => {
            if (call.tool !== 'model' || !/^plan-[01]:/.test(call.operationKey)) return false;
            const response = output(call) as { data?: { requirements?: unknown } };
            return Array.isArray(response.data?.requirements);
        });
        if (committedStructuredPlan && !planning) invalid();
        if (research?.artifactPolicy !== undefined && research.artifactPolicy !== 1) invalid();
        // Demo, saved-evidence revision and failed planning use explicit
        // unknown coverage. They have no successful planning receipt to authenticate.
        if (planning) {
            if (
                research?.artifactPolicy !== 1 ||
                !/^plan-[01]$/.test(planning.operationKey) ||
                !successful.some(
                    (call) =>
                        call.tool === 'model' &&
                        call.operationKey.startsWith(`${planning.operationKey}:`) &&
                        isDeepStrictEqual(output(call), planning.response),
                )
            )
                invalid();
        }
        // Quality assessments are accepted only with this Run's immutable model receipt.
        for (const receipt of [
            ...((proof.research as { synthesisExtractions?: ComparisonExtraction[] })
                ?.synthesisExtractions ?? []),
            ...((
                proof.research as {
                    modelAnswerExtractions?: ComparisonExtraction[];
                }
            )?.modelAnswerExtractions ?? []),
            ...((proof.research as { modelDraftExtractions?: ComparisonExtraction[] })
                ?.modelDraftExtractions ?? []),
        ])
            if (
                !successful.some(
                    (call) =>
                        call.tool === 'model' &&
                        call.operationKey.startsWith(`${receipt.operationKey}:`) &&
                        isDeepStrictEqual(output(call), receipt.response),
                )
            )
                invalid();
    }
    for (const page of candidate.pages) {
        if (
            typeof page.title !== 'string' ||
            page.title.length > 2000 ||
            !Number.isFinite(Date.parse(page.collectedAt)) ||
            new Date(page.collectedAt) > run.deadlineAt! ||
            typeof page.extractionVersion !== 'string' ||
            !page.extractionVersion ||
            typeof page.truncated !== 'boolean' ||
            page.untrusted !== true
        )
            invalid();
        if (
            !successful.some(
                (call) => call.tool === 'read' && isDeepStrictEqual(output(call), pageBody(page)),
            )
        )
            invalid();
    }
    if (candidate.manifest) {
        const extractions = (proof.research as { comparisonExtractions?: ComparisonExtraction[] })
            ?.comparisonExtractions;
        if (extractions) {
            for (const receipt of extractions) {
                const extraction = successful.find((call) => {
                    if (
                        call.tool !== 'model' ||
                        !call.operationKey.startsWith(`${receipt.operationKey}:`)
                    )
                        return false;
                    return comparisonReceiptMatchesOutput(receipt, output(call));
                });
                if (!extraction) invalid();
            }
            // candidateFromCheckpoint has already rebuilt all pages, valid facts,
            // uncertainty and coverage from these independently authenticated receipts.
        } else {
            const extractionKey = (proof.research as { comparisonRetried?: boolean })
                ?.comparisonRetried
                ? 'compare-facts-repair-v1:'
                : 'compare-facts-v1:';
            const extraction = successful.find(
                (call) => call.tool === 'model' && call.operationKey.startsWith(extractionKey),
            );
            // Decode the immutable wire output with the same domain rules as the Agent.
            const manifest = extraction
                ? manifestFromModel(
                      (output(extraction) as { data?: unknown }).data,
                      context,
                      candidate.pages,
                  )
                : null;
            if (!manifest || !isDeepStrictEqual(candidate.manifest, manifest)) invalid();
        }
    }
    return candidate;
}

/** Completion checks independent of a model or caller completeness flag. */
export function finalizeCoverage(
    candidate: AgentCandidate,
    run: Run,
    config: AgentContext['config'],
    proof: DeliveryProof,
    calls: ToolCall[],
    successful: ToolCall[],
): void {
    const gaps = [...candidate.coverage.gaps];
    const notes = [...(candidate.coverage.notes ?? [])];
    // Once every question is answered, collection limits are reported, not counted as missing answers.
    const answered =
        !proof.deadline &&
        (proof.research as { answerCompletionPolicy?: number } | undefined)
            ?.answerCompletionPolicy === 1 &&
        candidate.coverage.completeness === 'complete';
    const process = answered ? notes : gaps;
    // These checks are independent of a model/caller's completeness flag.
    if (candidate.pages.some((page) => page.truncated))
        process.push('存在已截断正文，无法保证完整查阅');
    if (candidate.pages.some((page) => page.collection?.complete === false))
        process.push('部分网页渲染或资源加载受限，无法保证完整查阅');
    const unresolvedCalls = calls.filter(
        (call) =>
            call.status !== 'succeeded' &&
            !successful.some(
                (done) =>
                    done.tool === call.tool &&
                    done.operationKey === call.operationKey &&
                    done.attemptNo > call.attemptNo,
            ),
    );
    if (unresolvedCalls.some((call) => ['reserved', 'running', 'unknown'].includes(call.status)))
        gaps.push('存在结果未确认的工具调用');
    else if (unresolvedCalls.length) process.push('存在失败或结果未确认的工具调用');
    if (calls.some((call) => call.status !== 'succeeded') && !unresolvedCalls.length)
        notes.push('临时工具故障已在原预算内重试恢复，相关成功结果已核验');
    if (!proof.deadline) {
        const state = proof.research as {
            queries: { query: string; questionIds: string[] }[];
            searches: { query: { query: string }; response: unknown }[];
            selections: { url: string; questionIds: string[] }[];
        };
        if (!state.queries.length || !state.searches.length) process.push('搜索计划未完成');
        for (const search of state.searches)
            if (
                (search.response as SearchResponse).query !== search.query.query ||
                !successful.some(
                    (call) =>
                        call.tool === 'search' &&
                        searchReceiptMatchesOutput(search.response, output(call)),
                )
            )
                invalid();
        for (const query of state.queries)
            if (!state.searches.some((entry) => entry.query.query === query.query))
                process.push('部分计划查询未取得成功结果');
        for (const [index, selection] of state.selections.entries())
            if (
                !candidate.pages.some(
                    (page) =>
                        page.id === `read-${index}` &&
                        page.originalUrl === selection.url &&
                        isDeepStrictEqual(page.questionIds, selection.questionIds),
                )
            )
                process.push('部分计划来源未完成正文采集');
        for (const page of candidate.pages) {
            const index = Number(page.id.replace(/^read-/, ''));
            const selection = state.selections[index];
            if (
                !selection ||
                page.originalUrl !== selection.url ||
                !isDeepStrictEqual(page.questionIds, selection.questionIds)
            )
                invalid();
        }
    }
    // Publication coverage is recomputed by candidateFromCheckpoint from page-authored facts.
    // The current source policy still cannot certify official identity.
    if (config.sourcePreferences.officialOnly)
        notes.push('来源已按用户指定范围筛选；范围匹配不等于独立认证官方身份');
    if (run.mode === 'demo')
        gaps.push('本次执行为固定演示资料，未验证互联网事实', candidate.demoReason!);
    candidate.coverage = parseContract(CoverageSchema, {
        ...candidate.coverage,
        delivery: classifyReportDelivery(
            candidate.coverage.reportValue,
            candidate.claims,
            candidate.coverage.artifacts,
        ),
        ...(notes.length ? { notes: [...new Set(notes)] } : {}),
        gaps: [...new Set(gaps)],
        completeness: gaps.length || proof.deadline ? 'partial' : 'complete',
    });
}

/** A comparison scope with a baseline cannot be advanced without a completed comparison. */
export function applyBaselineGaps(
    candidate: AgentCandidate,
    baseline: unknown,
    run: Run,
    context: AgentContext,
): void {
    if ((baseline || run.baselineRunId) && candidate.comparison === 'not_performed') {
        candidate.coverage = parseContract(CoverageSchema, {
            ...candidate.coverage,
            completeness: 'partial',
            gaps: [...new Set([...candidate.coverage.gaps, '连续比较尚未执行，不能推进已有基线'])],
        });
    }
    if (run.baselineRunId && context.baseline?.status !== 'ready') {
        candidate.coverage.completeness = 'partial';
        candidate.coverage.gaps = [
            ...new Set([
                ...candidate.coverage.gaps,
                '冻结基线的比较清单或引用不可用，未推断无变化',
            ]),
        ];
    }
}

export function deliveryOutcome(candidate: AgentCandidate, run: Run) {
    const complete = candidate.coverage.completeness === 'complete';
    const changes = candidate.changes ?? [];
    const outcome = !complete
        ? 'inconclusive'
        : !run.baselineRunId
          ? 'baseline'
          : changes.some((change) => change.important && change.kind === 'changed')
            ? 'important_change'
            : changes.some((change) => change.kind === 'new')
              ? 'new_findings'
              : 'no_important_change';
    return { complete, changes, outcome } as const;
}
