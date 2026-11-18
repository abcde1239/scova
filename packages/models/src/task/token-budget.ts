/** Pure stage policy shared by the Agent and task editor; no provider or Node dependencies. */
export const COMPARISON_BATCH_SIZE = 3;

export function researchOutputStages(total: number) {
    return {
        planning: Math.min(4000, Math.max(1, Math.floor(total / 8))),
        comparison: Math.min(24_000, Math.floor(total / 6)),
    };
}

/** Share a bounded comparison envelope, preserving batch/receipt boundaries. */
export function comparisonOutputLimits(pageCount: number, stageOutput: number) {
    if (!pageCount) return [];
    const count = Math.ceil(pageCount / COMPARISON_BATCH_SIZE);
    const oldInitial = Math.floor(stageOutput / count);
    if (count === 1) return [{ initial: oldInitial, repair: oldInitial * 2 }];
    const envelope = oldInitial * count * 3;
    const limits = Array.from({ length: count }, (_, i) => {
        const pages = Math.min(COMPARISON_BATCH_SIZE, pageCount - i * COMPARISON_BATCH_SIZE);
        const share = Math.floor((envelope * pages) / pageCount);
        const initial = Math.floor(share / 2);
        return { initial, repair: share - initial };
    });
    if (oldInitial >= 256 && limits.some((limit) => limit.initial < 256))
        return limits.map(() => ({
            initial: Math.floor((oldInitial * 3) / 2),
            repair: Math.ceil((oldInitial * 3) / 2),
        }));
    return limits;
}

export function researchSynthesisOutputLimits(remaining: number) {
    return {
        initial: Math.min(32_000, Math.max(1, Math.floor(remaining / 3))),
        repair: Math.min(64_000, Math.max(1, Math.floor((remaining * 2) / 3))),
    };
}

export function researchInputLimits(total: number, pageCount: number) {
    const batches = Math.ceil(pageCount / COMPARISON_BATCH_SIZE);
    return {
        planning: Math.min(256_000, Math.max(1, Math.floor(total / 10))),
        comparison: batches ? Math.floor(Math.min(192_000, total * 0.3) / batches) : 0,
        synthesis: Math.min(256_000, Math.max(1, Math.floor(total * 0.6))),
    };
}

export function taskTokenAllocation(budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxPages: number;
}) {
    if (Object.values(budget).some((v) => !Number.isSafeInteger(v) || v <= 0)) return null;
    // Agent reads at most 20 pages, even if a deployment allows a larger task limit.
    const pages = Math.min(20, budget.maxPages);
    const stages = researchOutputStages(budget.maxOutputTokens);
    const planning = { initial: stages.planning, repair: stages.planning * 2 };
    const batches = comparisonOutputLimits(pages, stages.comparison);
    const comparison = batches.reduce(
        (sum, batch) => ({
            initial: sum.initial + batch.initial,
            repair: sum.repair + batch.repair,
        }),
        { initial: 0, repair: 0 },
    );
    const synthesis = researchSynthesisOutputLimits(
        budget.maxOutputTokens -
            planning.initial -
            planning.repair -
            comparison.initial -
            comparison.repair,
    );
    const allocated =
        planning.initial +
        planning.repair +
        comparison.initial +
        comparison.repair +
        synthesis.initial +
        synthesis.repair;
    const input = researchInputLimits(budget.maxInputTokens, pages);
    // Advisory only: local tests repeatedly truncated batches below ~2000 tokens per page.
    // This does not change Agent reservations or promise completion above the threshold.
    const comparisonFits = (count: number) =>
        comparisonOutputLimits(count, stages.comparison).every(
            (batch, index) =>
                batch.initial >=
                Math.min(COMPARISON_BATCH_SIZE, count - index * COMPARISON_BATCH_SIZE) * 2000,
        );
    const recommendedPages =
        Array.from({ length: pages }, (_, i) => i + 1)
            .filter(comparisonFits)
            .at(-1) ?? 0;
    return {
        pages,
        batches,
        planning,
        comparison,
        synthesis,
        input,
        allocated,
        remaining: budget.maxOutputTokens - allocated,
        overBudget: allocated > budget.maxOutputTokens,
        comparisonTight: !comparisonFits(pages),
        recommendedPages,
        limited:
            planning.initial < 256 ||
            synthesis.initial < 256 ||
            batches.some((b) => b.initial < 256),
    };
}
