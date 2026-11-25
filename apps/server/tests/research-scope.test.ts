import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { effectiveRunScopeHash, researchComparisonScopeHash } from '@/utils/research-scope.ts';
import type { TaskConfig } from '@scova/models';
import { comparisonScopeHash } from '../src/service/tasks.ts';
import { runComparisonScopeHash } from '../src/service/runs.ts';
import { draftConfig } from './support/task-drafts.ts';

const config = (): TaskConfig => draftConfig();

it('keeps the existing versioned effective Run scope algorithm identical for both producers', () => {
    const expected = createHash('sha256')
        .update(JSON.stringify(['run-scope-v2', 'version-hash', 'live', 'scova-comparison-v1']))
        .digest('hex');
    expect(effectiveRunScopeHash('version-hash', 'live')).toBe(expected);
    expect(effectiveRunScopeHash('version-hash', 'demo')).not.toBe(expected);
});

describe('research collection scope', () => {
    it('date-unknown handling resets collection scope only when its effective policy changes', () => {
        const analysis = config();
        expect(comparisonScopeHash({ ...analysis, collectionDateUnknown: 'discard' })).toBe(
            comparisonScopeHash(analysis),
        );
        const collection: TaskConfig = { ...analysis, researchMode: 'collection' };
        expect(comparisonScopeHash({ ...collection, collectionDateUnknown: 'separate' })).toBe(
            comparisonScopeHash(collection),
        );
        expect(comparisonScopeHash({ ...collection, collectionDateUnknown: 'discard' })).not.toBe(
            comparisonScopeHash(collection),
        );
        expect(comparisonScopeHash({ ...analysis, timeRange: { kind: 'unbounded' } })).not.toBe(
            comparisonScopeHash(analysis),
        );
    });
    it('search overrides reset comparison scope while legacy defaults and unchanged retries remain stable', () => {
        const original = config();
        const inherited = { config: original, scope: 'f'.repeat(64) };
        expect(comparisonScopeHash({ ...original, searchMode: 'auto' })).toBe(
            comparisonScopeHash(original),
        );
        expect(runComparisonScopeHash({ ...original, searchMode: 'auto' }, 'live', inherited)).toBe(
            inherited.scope,
        );
        for (const searchMode of ['api', 'searxng'] as const) {
            const chosen = { ...original, searchMode };
            expect(comparisonScopeHash(chosen)).not.toBe(comparisonScopeHash(original));
            expect(runComparisonScopeHash(chosen, 'live', inherited)).toBe(
                runComparisonScopeHash(chosen, 'live'),
            );
            expect(runComparisonScopeHash(chosen, 'live', { ...inherited, config: chosen })).toBe(
                inherited.scope,
            );
        }
        expect(comparisonScopeHash({ ...original, searchMode: 'api' })).not.toBe(
            comparisonScopeHash({ ...original, searchMode: 'searxng' }),
        );
    });
    it('isolates collection targets while preserving non-research edits', () => {
        const original = config();
        const scope = comparisonScopeHash(original);
        expect(researchComparisonScopeHash(original)).toBe(scope);
        expect(comparisonScopeHash({ ...original, outputFormat: 'comparison' })).not.toBe(scope);
        expect(comparisonScopeHash({ ...original, outputFormats: ['brief'] })).toBe(scope);
        expect(comparisonScopeHash({ ...original, title: 'changed', timezone: 'UTC' })).toBe(scope);
        expect(
            comparisonScopeHash({ ...original, budget: { ...original.budget, maxPages: 1 } }),
        ).toBe(scope);
    });

    it('normalizes multi-format order without losing the selected set', () => {
        const first: TaskConfig = {
            ...config(),
            outputFormat: 'brief',
            outputFormats: ['brief', 'comparison'],
        };
        const reordered: TaskConfig = {
            ...first,
            outputFormat: 'comparison',
            outputFormats: ['comparison', 'brief'],
        };
        expect(comparisonScopeHash(first)).toBe(comparisonScopeHash(reordered));
        expect(comparisonScopeHash(first)).not.toBe(comparisonScopeHash(config()));
    });

    it('computes fresh manual scopes from effective config rather than a saved version hash', () => {
        const original = config();
        const chosen: TaskConfig = {
            ...original,
            outputFormat: 'list',
            outputFormats: ['list', 'research_report'],
        };
        expect(runComparisonScopeHash(chosen, 'live')).toBe(
            effectiveRunScopeHash(comparisonScopeHash(chosen), 'live'),
        );
        expect(runComparisonScopeHash(chosen, 'live')).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
    });

    it('keeps unchanged retry and followup identities, but changed collection forms get a new scope', () => {
        const original = config();
        const frozen = 'f'.repeat(64);
        expect(runComparisonScopeHash(original, 'live', { config: original, scope: frozen })).toBe(
            frozen,
        );
        expect(
            runComparisonScopeHash({ ...original, outputFormats: ['brief'] }, 'live', {
                config: original,
                scope: frozen,
            }),
        ).toBe(frozen);
        const changed: TaskConfig = { ...original, outputFormat: 'comparison' };
        expect(runComparisonScopeHash(changed, 'live', { config: original, scope: frozen })).toBe(
            runComparisonScopeHash(changed, 'live'),
        );
        expect(runComparisonScopeHash(original, 'live', { questionId: 'question-a' })).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
        expect(runComparisonScopeHash(original, 'live', { questionId: 'question-a' })).not.toBe(
            runComparisonScopeHash(original, 'live', { questionId: 'question-b' }),
        );
        expect(runComparisonScopeHash(original, 'demo')).not.toBe(
            runComparisonScopeHash(original, 'live'),
        );
    });
});
