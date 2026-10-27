import type { ReadPublication } from './types.ts';

const VERSION = 'scova-publication-v1';
const MAX_OBSERVATIONS = 32;
const MAX_VALUE = 256;
const fields = new Set(['article:published_time', 'datePublished', 'time[datetime]']);
const articleTypes = new Set([
    'Article',
    'NewsArticle',
    'BlogPosting',
    'Report',
    'ScholarlyArticle',
    'SocialMediaPosting',
    'TechArticle',
    'DiscussionForumPosting',
]);
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
    const result = validatePublication(value);
    if (result.status !== 'known') return result.status;
    const lower = start instanceof Date ? start.getTime() : Date.parse(instant(start) ?? '');
    const upper = end instanceof Date ? end.getTime() : Date.parse(instant(end) ?? '');
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return 'unknown';
    const published = Date.parse(result.instant!);
    return published >= lower && published <= upper ? 'in_window' : 'outside';
}

/** Read page-authored metadata before scripts are discarded; scripts are parsed as JSON, never executed. */
export function extractPublication(document: Document): ReadPublication {
    const observations: ReadPublication['observations'] = [];
    const documentUrl = new URL(document.URL);
    documentUrl.hash = '';
    const matchesDocument = (values: unknown[]) => {
        if (values.length === 0) return false;
        return values.every((value) => {
            const raw =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? (value as Record<string, unknown>)['@id']
                    : value;
            if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) return false;
            try {
                // Use the fetched document URL, never a page-controlled <base> URL.
                const identity = new URL(raw, document.URL);
                identity.hash = '';
                return (
                    ['http:', 'https:'].includes(identity.protocol) &&
                    identity.href === documentUrl.href
                );
            } catch {
                return false;
            }
        });
    };
    let overflow = false;
    const add = (
        field: ReadPublication['observations'][number]['field'],
        raw: unknown,
        locator: string,
    ) => {
        if (
            observations.length >= MAX_OBSERVATIONS ||
            typeof raw !== 'string' ||
            raw.length > MAX_VALUE ||
            locator.length > MAX_VALUE
        ) {
            overflow = true;
            return;
        }
        observations.push({ field, rawValue: raw, locator });
    };
    [...document.head.querySelectorAll('meta[property],meta[name]')].forEach((node, index) => {
        if (
            (node.getAttribute('property') ?? node.getAttribute('name'))?.toLowerCase() ===
            'article:published_time'
        )
            add(
                'article:published_time',
                node.getAttribute('content') ?? '',
                `meta[${index}][article:published_time]`,
            );
    });
    [...document.querySelectorAll('main time[datetime],article time[datetime]')].forEach(
        (node, index) => {
            const properties = node.getAttribute('itemprop')?.split(/\s+/) ?? [];
            if (properties.includes('dateModified')) return;
            if (!properties.includes('datePublished') && !node.hasAttribute('pubdate')) return;
            const scope = node.closest('article') ?? node.closest('main');
            if (
                !scope ||
                scope.parentElement?.closest('article') ||
                node.closest('aside,nav,footer,header')
            )
                return;
            const identities = ['itemid', 'resource', 'about'].flatMap((attribute) => {
                const value = scope.getAttribute(attribute);
                return value === null ? [] : [value];
            });
            if (!matchesDocument(identities)) return;
            add(
                'time[datetime]',
                node.getAttribute('datetime') ?? '',
                `main/article time[datetime][${index}]`,
            );
        },
    );
    let nodes = 0;
    const visit = (value: unknown, path: string, depth: number) => {
        if (++nodes > 2000 || depth > 20) {
            overflow = true;
            return;
        }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
            return;
        }
        const record = value as Record<string, unknown>;
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        const isArticle = types.some(
            (type) =>
                typeof type === 'string' &&
                articleTypes.has(type.replace(/^https?:\/\/schema\.org\//, '')),
        );
        const identities = ['url', '@id', 'mainEntityOfPage']
            .filter((key) => key in record)
            .map((key) => record[key]);
        if (isArticle && 'datePublished' in record && matchesDocument(identities))
            add('datePublished', record.datePublished, `${path}.datePublished`);
        for (const [key, child] of Object.entries(record)) {
            if (child && typeof child === 'object') visit(child, `${path}.${key}`, depth + 1);
        }
    };
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let totalLength = 0;
    if (scripts.length > 16) overflow = true;
    for (let index = 0; index < Math.min(scripts.length, 16); index++) {
        const text = scripts[index]!.textContent ?? '';
        totalLength += text.length;
        if (text.length > 262_144 || totalLength > 524_288) {
            overflow = true;
            continue;
        }
        try {
            visit(JSON.parse(text), `jsonld[${index}]$`, 0);
        } catch {
            overflow = true;
        }
    }
    if (overflow) return { parserVersion: VERSION, observations: [], ...unknown() };
    const result = { parserVersion: VERSION, observations, ...unknown() } as ReadPublication;
    return { ...result, ...validatePublication(result) };
}
