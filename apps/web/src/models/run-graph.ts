import type { RunGraphSnapshot } from '@scova/models';

export type GraphStep = RunGraphSnapshot['nodes'][number]['id'];
export type GraphAttempt = RunGraphSnapshot['instances'][number]['attempts'][number];
export const graphStatusLabels = {
    running: '运行中',
    succeeded: '已完成',
    interrupted: '已中断',
    unknown: '结果未确认',
    canceled: '已取消',
    failed: '失败',
    unvisited: '尚未执行',
    legacy: '历史阶段记录',
} as const;

/** Keep repeated node instances separate; a newer failure never rewrites an older success. */
export function graphNodeState(snapshot: RunGraphSnapshot, step: GraphStep) {
    const instances = snapshot.instances.filter((entry) => entry.step === step);
    const last = instances.at(-1);
    const attempt = last?.attempts.at(-1);
    const legacy = snapshot.legacySteps.find((entry) => entry.step === step);
    const status: GraphAttempt['status'] | 'legacy' | 'unvisited' =
        attempt?.status ?? (snapshot.precision === 'legacy' ? 'legacy' : 'unvisited');
    return {
        instances,
        status,
        completed: instances.filter((entry) => entry.attempts.at(-1)?.status === 'succeeded')
            .length,
        legacy,
        durationMs: instances
            .flatMap((entry) => entry.attempts)
            .reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0),
    };
}

export function graphDuration(milliseconds: number | null) {
    if (milliseconds === null) return '耗时待确认';
    const seconds = milliseconds / 1000;
    return seconds < 60
        ? `${seconds.toFixed(1)} 秒`
        : `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`;
}

// Drawing coordinates only. Node text and layout use rem and retain the reader's font size.
const positions: Partial<Record<GraphStep, [number, number]>> = {
    load_context: [12.5, 10],
    plan: [37.5, 10],
    model_draft: [62.5, 10],
    search: [87.5, 10],
    select: [87.5, 30],
    read: [62.5, 30],
    verify: [37.5, 30],
    synthesize: [12.5, 30],
    validate: [12.5, 50],
    gap_loop: [37.5, 50],
    conflict_review: [62.5, 50],
    answer_supplement: [87.5, 50],
    model_answer: [37.5, 70],
    compare: [62.5, 70],
    ready_for_delivery: [87.5, 70],
};
export function graphPosition(step: GraphStep, index: number): [number, number] {
    return positions[step] ?? [12.5 + (index % 4) * 25, 10 + Math.floor(index / 4) * 20];
}
export function graphEdgePath(from: [number, number], to: [number, number]) {
    const [x, y] = from;
    const [nextX, nextY] = to;
    if (x === nextX && y === nextY)
        return `M ${x * 10 + 35} ${y * 10 - 30} C ${x * 10 + 120} ${y * 10 - 120}, ${x * 10 + 120} ${y * 10 + 120}, ${x * 10 + 35} ${y * 10 + 30}`;
    return `M ${x * 10} ${y * 10} L ${nextX * 10} ${nextY * 10}`;
}
