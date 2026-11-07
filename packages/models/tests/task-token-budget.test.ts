import { describe, expect, it } from 'vite-plus/test';
import {
    taskTokenAllocation,
    DEFAULT_TASK_BUDGET,
    researchOutputStages,
    comparisonOutputLimits,
    researchSynthesisOutputLimits,
} from '../src/index.ts';

describe('shared task token allocation', () => {
    it('keeps the 10-page weighted envelope and both report attempts within the total', () => {
        const plan = taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, maxPages: 10 })!;
        expect(plan.planning).toEqual({ initial: 4000, repair: 8000 });
        expect(plan.batches).toEqual([
            { initial: 9599, repair: 9599 },
            { initial: 9599, repair: 9599 },
            { initial: 9599, repair: 9599 },
            { initial: 3199, repair: 3200 },
        ]);
        expect(plan.synthesis).toEqual({ initial: 17335, repair: 34671 });
        expect(plan.allocated).toBe(127999);
        expect(plan.remaining).toBe(1);
        expect(plan.input).toEqual({ planning: 100000, comparison: 48000, synthesis: 256000 });
    });
    it('reserves all retry combinations for low, default and deployment maximum budgets', () => {
        for (const total of [500, 8000, 128000, 512000, Number.MAX_SAFE_INTEGER]) {
            for (let pages = 1; pages <= 20; pages++) {
                const plan = taskTokenAllocation({
                    maxInputTokens: 1000000,
                    maxOutputTokens: total,
                    maxPages: pages,
                })!;
                expect(plan.allocated).toBeLessThanOrEqual(total);
                expect(plan.remaining).toBeGreaterThanOrEqual(0);
                for (const planningRetried of [false, true])
                    for (const comparisonRetried of [false, true]) {
                        const planning =
                            plan.planning.initial + (planningRetried ? plan.planning.repair : 0);
                        const comparison =
                            plan.comparison.initial +
                            (comparisonRetried ? plan.comparison.repair : 0);
                        const synthesis = researchSynthesisOutputLimits(
                            total - planning - comparison,
                        );
                        expect(
                            planning + comparison + synthesis.initial + synthesis.repair,
                        ).toBeLessThanOrEqual(total);
                    }
            }
        }
    });
    it('caps pages to the actual Agent read limit and preserves single-batch repair limits', () => {
        expect(taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, maxPages: 100 })?.pages).toBe(20);
        expect(comparisonOutputLimits(3, researchOutputStages(128000).comparison)).toEqual([
            { initial: 21333, repair: 42666 },
        ]);
        expect(taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, maxOutputTokens: 500 })?.limited).toBe(
            true,
        );
    });
    it('does not present an invalid or impossible tiny budget as a safe allocation', () => {
        for (const value of [0, -1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
            for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxPages'])
                expect(taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, [key]: value })).toBeNull();
        }
        expect(
            taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, maxOutputTokens: 1 })?.overBudget,
        ).toBe(true);
    });
    it('advises fewer pages when per-batch allowance is tight without changing allocation', () => {
        const normal = taskTokenAllocation({ ...DEFAULT_TASK_BUDGET, maxPages: 10 })!;
        expect(normal.comparisonTight).toBe(false);
        const tight = taskTokenAllocation({
            ...DEFAULT_TASK_BUDGET,
            maxPages: 10,
            maxOutputTokens: 64000,
        })!;
        expect(tight.comparisonTight).toBe(true);
        expect(tight.recommendedPages).toBe(7);
        expect(tight.overBudget).toBe(false);
        expect(taskTokenAllocation(DEFAULT_TASK_BUDGET)?.recommendedPages).toBe(15);
    });
});
