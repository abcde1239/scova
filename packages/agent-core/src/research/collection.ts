import { describePublication, publicationDateSource } from '@scova/connectors';
import type { AgentContext, AgentPage } from '../types.ts';
import type { Coverage } from '@scova/models';
import { researchWindow } from './context.ts';

/** Dates are connector observations; an unknown publication can use a separately parsed update. */
export function collectionDateEntry(context: AgentContext, page: AgentPage) {
    const dates = describePublication(page.publication);
    const kind = dates.published.status === 'unknown' ? 'modified' : 'published';
    const date = dates[kind];
    const window = researchWindow(context);
    const lower = Date.parse(window.start ?? ''),
        upper = Date.parse(window.end ?? '');
    const earliest = Date.parse(date.earliest ?? ''),
        latest = Date.parse(date.latest ?? '');
    const confirmed = date.status === 'known' && Number.isFinite(lower) && Number.isFinite(upper);
    const status =
        confirmed && earliest >= lower && latest <= upper
            ? 'accepted'
            : confirmed && (latest < lower || earliest > upper)
              ? 'outside'
              : 'unconfirmed';
    return {
        pageId: page.id,
        url: page.url,
        title: page.title || null,
        publishedAt: date.instant,
        dateValue: date.value,
        dateKind: kind,
        status,
        dateSource: publicationDateSource(page.publication, kind),
    } satisfies NonNullable<Coverage['dateScreening']>['entries'][number];
}

export function collectionDateScreening(
    context: AgentContext,
    entries: NonNullable<Coverage['dateScreening']>['entries'],
): Coverage['dateScreening'] {
    const window = researchWindow(context);
    if (!window.start || !window.end) return undefined;
    return {
        window: { start: window.start, end: window.end },
        unconfirmedHandling: context.config.collectionDateUnknown ?? 'separate',
        accepted: entries.filter((e) => e.status === 'accepted').length,
        unconfirmed: entries.filter((e) => e.status === 'unconfirmed').length,
        outside: entries.filter((e) => e.status === 'outside').length,
        entries,
    };
}
