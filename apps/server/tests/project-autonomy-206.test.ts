import { describe, expect, it } from 'vite-plus/test';
import type { ProjectAutonomyInput, ProjectAutonomyOperation } from '@scova/models';
import { decideProjectAutonomy } from '@/service/project-autonomy.ts';

const modes = ['ask', 'budgeted', 'autonomous'] as const;
const authorized = { target: 'explicit', budget: 'authorized' } as const;
const matrix = [
    ['read', 'execute', 'execute', 'execute'],
    ['propose_research', 'confirm', 'confirm', 'confirm'],
    ['start_run', 'confirm', 'execute', 'execute'],
    ['create_schedule', 'confirm', 'confirm', 'execute'],
    ['update_schedule', 'confirm', 'confirm', 'confirm'],
    ['pause_task', 'confirm', 'confirm', 'execute'],
    ['cancel_run', 'confirm', 'confirm', 'confirm'],
    ['delete', 'confirm', 'confirm', 'confirm'],
    ['unlink', 'confirm', 'confirm', 'confirm'],
    ['update_project_settings', 'confirm', 'confirm', 'confirm'],
] as const satisfies ReadonlyArray<readonly [ProjectAutonomyOperation, ...string[]]>;

describe('project autonomy policy', () => {
    it.each(matrix)('decides %s across the three modes', (operation, ...outcomes) => {
        expect(
            modes.map(
                (autonomy) => decideProjectAutonomy({ ...authorized, autonomy, operation }).outcome,
            ),
        ).toEqual(outcomes);
    });

    it.each([
        [{ target: 'ambiguous' }, { outcome: 'clarify', reason: 'ambiguous_target' }],
        [{ target: 'outside_project' }, { outcome: 'deny', reason: 'outside_project' }],
        [{ target: 'inferred' }, { outcome: 'confirm', reason: 'explicit_target_required' }],
        [{ budget: 'unavailable' }, { outcome: 'confirm', reason: 'budget_unavailable' }],
        [{ budget: 'exceeded' }, { outcome: 'confirm', reason: 'budget_exceeded' }],
    ] as const)('enforces the server guards for %j', (guard, outcome) => {
        for (const operation of ['start_run', 'create_schedule', 'pause_task'] as const) {
            const input: ProjectAutonomyInput = {
                ...authorized,
                autonomy: 'autonomous',
                operation,
                ...guard,
            };
            expect(decideProjectAutonomy(input)).toEqual(outcome);
        }
    });

    it('rejects an out-of-project read before it reaches a tool', () => {
        expect(
            decideProjectAutonomy({
                ...authorized,
                autonomy: 'ask',
                operation: 'read',
                target: 'outside_project',
            }),
        ).toEqual({ outcome: 'deny', reason: 'outside_project' });
    });
});
