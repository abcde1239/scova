import type { ProjectAutonomyDecision, ProjectAutonomyInput } from '@scova/models';

export function decideProjectAutonomy(input: ProjectAutonomyInput): ProjectAutonomyDecision {
    const { autonomy, operation, target, budget } = input;
    if (target === 'outside_project') return { outcome: 'deny', reason: 'outside_project' };
    if (target === 'ambiguous') return { outcome: 'clarify', reason: 'ambiguous_target' };
    if (operation === 'read') return { outcome: 'execute' };
    if (budget === 'exceeded') return { outcome: 'confirm', reason: 'budget_exceeded' };

    const permitsAuto =
        (operation === 'start_run' && autonomy !== 'ask') ||
        (autonomy === 'autonomous' &&
            (operation === 'create_schedule' || operation === 'pause_task'));
    if (!permitsAuto) return { outcome: 'confirm', reason: 'policy' };
    if (target !== 'explicit') return { outcome: 'confirm', reason: 'explicit_target_required' };
    if (budget !== 'authorized') return { outcome: 'confirm', reason: 'budget_unavailable' };
    return { outcome: 'execute' };
}
