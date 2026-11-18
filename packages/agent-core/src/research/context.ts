import type { AgentContext } from '../types.ts';

export function researchWindow(context: AgentContext) {
    const range = context.config.timeRange;
    if (range.kind === 'unbounded')
        return {
            timezone: context.config.timezone,
            asOf: context.startedAt?.toISOString() ?? null,
            start: null,
            end: null,
        };
    const end = range.kind === 'fixed' ? new Date(range.end) : context.startedAt;
    const start =
        range.kind === 'fixed'
            ? new Date(range.start)
            : end && new Date(end.getTime() - range.days * 86_400_000);
    return {
        timezone: context.config.timezone,
        asOf: context.startedAt?.toISOString() ?? null,
        start: start?.toISOString() ?? null,
        end: end?.toISOString() ?? null,
    };
}

export function scopedQuery(query: string, context: AgentContext): string {
    const window = researchWindow(context);
    const firstYear = Number(window.start?.slice(0, 4));
    const lastYear = Number(window.end?.slice(0, 4));
    const explicit = `${context.config.topic} ${context.config.goal} ${context.config.focusPoints.join(' ')}`;
    return query
        .replace(/\b(?:19|20)\d{2}\b/g, (year) =>
            !window.end ||
            (Number(year) >= firstYear && Number(year) <= lastYear) ||
            explicit.includes(year)
                ? year
                : '',
        )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}
