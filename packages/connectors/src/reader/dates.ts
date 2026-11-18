import type { ReadPublication, PublicationDate } from '../types.ts';
import { validatePublicationV2 } from './publication.ts';

const VERSION = 'scova-publication-v1';
const MAX_OBSERVATIONS = 32;
const MAX_VALUE = 256;
const fields = new Set(['article:published_time', 'datePublished', 'time[datetime]']);
type Assessment = Pick<ReadPublication, 'status' | 'instant'>;
const unknown = (): Assessment => ({ status: 'unknown', instant: null });

/** Only explicit timezone ISO timestamps are usable; Date.parse must not repair invalid calendar dates. */
function instant(value: string): string | null {
    const match =
        /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(
            value.trim(),
        );
    if (!match) return null;
    const [, year, month, day, , , , offset] = match;
    // RFC 3339 -00:00 explicitly denotes an unknown local offset.
    if (offset === '-00:00') return null;
    if (offset !== 'Z' && offset!.slice(1, 3) === '14' && offset!.slice(4) !== '00') return null;
    const calendar = new Date(0);
    calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    if (
        calendar.getUTCFullYear() !== Number(year) ||
        calendar.getUTCMonth() + 1 !== Number(month) ||
        calendar.getUTCDate() !== Number(day)
    )
        return null;
    const timestamp = Date.parse(value.trim());
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Recompute from bounded observations; stored status/instant are never authority. */
export function validatePublication(value: unknown): Assessment {
    if (
        value &&
        typeof value === 'object' &&
        Reflect.get(value, 'parserVersion') === 'scova-publication-v2'
    ) {
        const { published } = validatePublicationV2(value);
        return { status: published.status, instant: published.instant };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown();
    const candidate = value as Record<string, unknown>;
    if (
        candidate.parserVersion !== VERSION ||
        !['known', 'unknown', 'conflict'].includes(candidate.status as string) ||
        !(
            candidate.instant === null ||
            (typeof candidate.instant === 'string' && candidate.instant.length <= MAX_VALUE)
        ) ||
        !Array.isArray(candidate.observations) ||
        candidate.observations.length > MAX_OBSERVATIONS
    )
        return unknown();
    const dates: string[] = [];
    let uncertain = false;
    for (const observation of candidate.observations) {
        if (!observation || typeof observation !== 'object' || Array.isArray(observation))
            return unknown();
        const entry = observation as Record<string, unknown>;
        if (
            typeof entry.field !== 'string' ||
            !fields.has(entry.field) ||
            typeof entry.rawValue !== 'string' ||
            entry.rawValue.length > MAX_VALUE ||
            typeof entry.locator !== 'string' ||
            !entry.locator.trim() ||
            entry.locator.length > MAX_VALUE
        )
            return unknown();
        const parsed = instant(entry.rawValue);
        if (parsed) dates.push(parsed);
        else uncertain = true;
    }
    const distinct = [...new Set(dates)];
    if (distinct.length > 1) return { status: 'conflict', instant: null };
    if (!uncertain && distinct.length === 1) return { status: 'known', instant: distinct[0]! };
    return unknown();
}

/** Inclusive interval of instants; never substitutes collection time or search metadata. */
export function assessPublication(
    value: unknown,
    start: string | Date,
    end: string | Date,
): 'in_window' | 'outside' | 'unknown' | 'conflict' {
    if (
        value &&
        typeof value === 'object' &&
        Reflect.get(value, 'parserVersion') === 'scova-publication-v2'
    ) {
        const { published } = validatePublicationV2(value);
        if (published.status !== 'known') return published.status;
        const lower = start instanceof Date ? start.getTime() : Date.parse(instant(start) ?? '');
        const upper = end instanceof Date ? end.getTime() : Date.parse(instant(end) ?? '');
        if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return 'unknown';
        const earliest = Date.parse(published.earliest!),
            latest = Date.parse(published.latest!);
        if (earliest >= lower && latest <= upper) return 'in_window';
        if (latest < lower || earliest > upper) return 'outside';
        return 'unknown';
    }
    const result = validatePublication(value);
    if (result.status !== 'known') return result.status;
    const lower = start instanceof Date ? start.getTime() : Date.parse(instant(start) ?? '');
    const upper = end instanceof Date ? end.getTime() : Date.parse(instant(end) ?? '');
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return 'unknown';
    const published = Date.parse(result.instant!);
    return published >= lower && published <= upper ? 'in_window' : 'outside';
}

export function describePublication(value: unknown): {
    published: PublicationDate;
    modified: PublicationDate;
} {
    if (
        value &&
        typeof value === 'object' &&
        Reflect.get(value, 'parserVersion') === 'scova-publication-v2'
    )
        return validatePublicationV2(value);
    const result = validatePublication(value);
    return {
        published: {
            ...result,
            value: result.instant,
            precision: result.instant ? 'instant' : null,
            earliest: result.instant,
            latest: result.instant,
        },
        modified: {
            status: 'unknown',
            instant: null,
            value: null,
            precision: null,
            earliest: null,
            latest: null,
        },
    };
}

/** Labels come from validated connector observations, never the model or stored summary fields. */
export function publicationDateSource(
    value: unknown,
    kind: 'published' | 'modified' = 'published',
): string | null {
    if (describePublication(value)[kind].status !== 'known') return null;
    const allowed = new Set(
        kind === 'published'
            ? ['article:published_time', 'datePublished', 'time[datetime]', 'meta:published']
            : ['dateModified', 'meta:modified', 'time:modified'],
    );
    const observations: unknown = Reflect.get(value as object, 'observations');
    if (!Array.isArray(observations)) return null;
    const sources = [
        ...new Set(
            observations
                .map((entry: unknown) =>
                    entry && typeof entry === 'object' ? Reflect.get(entry, 'field') : undefined,
                )
                .filter(
                    (field): field is string => typeof field === 'string' && allowed.has(field),
                ),
        ),
    ];
    return sources.length ? sources.sort().join(' / ') : null;
}

/** Current extraction keeps publication and modification observations separate. */
export { extractPublicationV2 as extractPublication } from './publication.ts';
