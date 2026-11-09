import { normalizeUrl } from './http.ts';
import type { PublicationDate, ReadPublication } from './types.ts';

const empty = (status: PublicationDate['status'] = 'unknown'): PublicationDate => ({
    status,
    instant: null,
    value: null,
    precision: null,
    earliest: null,
    latest: null,
});
const publishedFields = new Set([
    'article:published_time',
    'datePublished',
    'time[datetime]',
    'meta:published',
]);
const modifiedFields = new Set(['dateModified', 'meta:modified', 'time:modified']);
const publishedMeta = new Set([
    'article:published_time',
    'datepublished',
    'pubdate',
    'publishdate',
    'publish_date',
    'publication_date',
    'dc.date.issued',
    'dcterms.issued',
    'parsely-pub-date',
    'sailthru.date',
]);
const modifiedMeta = new Set([
    'article:modified_time',
    'datemodified',
    'last-modified',
    'dc.date.modified',
    'dcterms.modified',
]);
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

/** A date/local clock describes a range of possible UTC instants, never an invented timezone. */
function parseDate(raw: string): PublicationDate | null {
    const value = raw
        .trim()
        .replace(
            /^(?:发布时间|发布日期|发表时间|更新于|更新时间|Published(?:\s+on)?|Updated(?:\s+on)?)\s*[:：]?\s*/i,
            '',
        );
    const normalized = value
        .replace(
            /^(\d{4})年(\d{1,2})月(\d{1,2})日/,
            (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
        )
        .replace(
            /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
            (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
        );
    const match =
        /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,9})?)?(Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?)?$/.exec(
            normalized,
        );
    if (!match) return null;
    const [, y, m, d, hour, minute, second, fraction, zone] = match;
    const calendar = new Date(0);
    calendar.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
    if (
        calendar.getUTCFullYear() !== Number(y) ||
        calendar.getUTCMonth() + 1 !== Number(m) ||
        calendar.getUTCDate() !== Number(d)
    )
        return null;
    if (zone === '-00:00' || zone === '-0000') return null;
    if (
        zone &&
        zone !== 'Z' &&
        zone.slice(1, 3) === '14' &&
        zone.replace(':', '').slice(3) !== '00'
    )
        return null;
    const date = `${y}-${m}-${d}`;
    const clock = hour ? `${date}T${hour}:${minute}:${second ?? '00'}${fraction ?? ''}` : date;
    if (zone) {
        const offset =
            zone === 'Z' ? zone : `${zone.slice(0, 3)}:${zone.replace(':', '').slice(3)}`;
        const timestamp = Date.parse(clock + offset);
        if (!Number.isFinite(timestamp)) return null;
        const instant = new Date(timestamp).toISOString();
        return {
            status: 'known',
            value: instant,
            instant,
            precision: 'instant',
            earliest: instant,
            latest: instant,
        };
    }
    const local = Date.parse(hour ? `${clock}Z` : `${date}T00:00:00Z`);
    return {
        status: 'known',
        instant: null,
        value: hour ? clock : date,
        precision: hour ? 'local' : 'day',
        earliest: new Date(local - 14 * 3600_000).toISOString(),
        latest: new Date(local + 12 * 3600_000 + (hour ? 0 : 86400_000 - 1)).toISOString(),
    };
}

function combine(values: string[]): PublicationDate {
    const parsed = values.map(parseDate).filter((v): v is PublicationDate => !!v);
    if (!parsed.length) return empty();
    // Different declared calendar dates/local clocks remain conflicting even when
    // their unknown-timezone UTC ranges overlap.
    for (const precision of ['day', 'local'] as const)
        if (new Set(parsed.filter((v) => v.precision === precision).map((v) => v.value)).size > 1)
            return empty('conflict');
    const earliest = Math.max(...parsed.map((v) => Date.parse(v.earliest!)));
    const latest = Math.min(...parsed.map((v) => Date.parse(v.latest!)));
    if (earliest > latest) return empty('conflict');
    // Choose the most precise original observation, while retaining the conservative intersection.
    parsed.sort(
        (a, b) =>
            Date.parse(a.latest!) -
            Date.parse(a.earliest!) -
            (Date.parse(b.latest!) - Date.parse(b.earliest!)),
    );
    return {
        ...parsed[0]!,
        earliest: new Date(earliest).toISOString(),
        latest: new Date(latest).toISOString(),
    };
}

export function validatePublicationV2(value: unknown): {
    published: PublicationDate;
    modified: PublicationDate;
} {
    const unknown = () => ({ published: empty(), modified: empty() });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown();
    const data = value as ReadPublication;
    if (
        data.parserVersion !== 'scova-publication-v2' ||
        !['known', 'unknown', 'conflict'].includes(data.status) ||
        !(
            data.instant === null ||
            (typeof data.instant === 'string' && data.instant.length <= 256)
        ) ||
        !Array.isArray(data.observations) ||
        data.observations.length > 32
    )
        return unknown();
    const published: string[] = [],
        modified: string[] = [];
    for (const o of data.observations) {
        if (
            !o ||
            typeof o !== 'object' ||
            typeof o.field !== 'string' ||
            (!publishedFields.has(o.field) && !modifiedFields.has(o.field)) ||
            typeof o.rawValue !== 'string' ||
            o.rawValue.length > 256 ||
            typeof o.locator !== 'string' ||
            !o.locator.trim() ||
            o.locator.length > 256
        )
            return unknown();
        (publishedFields.has(o.field) ? published : modified).push(o.rawValue);
    }
    return { published: combine(published), modified: combine(modified) };
}

/** Extract only explicit publication/update markers; never use HTTP Date, collection time or deadlines. */
export function extractPublicationV2(document: Document): ReadPublication {
    const observations: ReadPublication['observations'] = [];
    let overflow = false;
    const add = (
        field: ReadPublication['observations'][number]['field'],
        raw: unknown,
        locator: string,
    ) => {
        if (typeof raw !== 'string' || !raw.trim()) return;
        if (raw.length > 256 || locator.length > 256 || observations.length >= 32) {
            overflow = true;
            return;
        }
        observations.push({ field, rawValue: raw.trim(), locator });
    };
    const documentUrl = new URL(document.URL);
    const identities = new Set([normalizeUrl(document.URL)]);
    for (const node of document.head.querySelectorAll('link[rel="canonical"]')) {
        try {
            const url = new URL(node.getAttribute('href') ?? '', document.URL);
            if (url.origin === documentUrl.origin) identities.add(normalizeUrl(url.href));
        } catch {
            /* A malformed canonical link is not an identity. */
        }
    }
    const matches = (values: unknown[]) =>
        values.length > 0 &&
        values.every((value) => {
            const raw =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? Reflect.get(value, '@id')
                    : value;
            if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) return false;
            try {
                return identities.has(normalizeUrl(new URL(raw, document.URL).href));
            } catch {
                return false;
            }
        });
    [...document.head.querySelectorAll('meta[property],meta[name],meta[itemprop]')].forEach(
        (node, i) => {
            const key = (
                node.getAttribute('property') ??
                node.getAttribute('name') ??
                node.getAttribute('itemprop') ??
                ''
            ).toLowerCase();
            if (publishedMeta.has(key))
                add(
                    key === 'article:published_time' ? 'article:published_time' : 'meta:published',
                    node.getAttribute('content'),
                    `head meta[${i}][${key}]`,
                );
            if (modifiedMeta.has(key))
                add('meta:modified', node.getAttribute('content'), `head meta[${i}][${key}]`);
        },
    );
    const articles = [...document.querySelectorAll('article')].filter(
        (node) => !node.parentElement?.closest('article,aside,nav,footer'),
    );
    const primary = articles.length === 1 ? articles[0] : null;
    [
        ...document.querySelectorAll(
            'article time,main time,article [itemprop="datePublished"],article [itemprop="dateModified"]',
        ),
    ].forEach((node, i) => {
        const props = node.getAttribute('itemprop')?.split(/\s+/) ?? [];
        const modified = props.includes('dateModified') || node.classList.contains('updated');
        const published =
            props.includes('datePublished') ||
            node.hasAttribute('pubdate') ||
            node.classList.contains('published');
        if ((!published && !modified) || node.closest('aside,nav,footer')) return;
        const scope = node.closest('article') ?? node.closest('main');
        if (!scope || scope.parentElement?.closest('article')) return;
        const ids = ['itemid', 'resource', 'about'].flatMap((a) =>
            scope.hasAttribute(a) ? [scope.getAttribute(a)] : [],
        );
        if (ids.length ? !matches(ids) : scope !== primary) return;
        add(
            modified ? 'time:modified' : 'time[datetime]',
            node.getAttribute('datetime') ?? node.getAttribute('content') ?? node.textContent,
            `article publication[${i}]`,
        );
    });
    let nodes = 0;
    const title = (primary?.querySelector('h1')?.textContent ?? document.title).trim();
    const visit = (value: unknown, path: string, depth: number, rootArticle: boolean) => {
        if (++nodes > 2000 || depth > 20) {
            overflow = true;
            return;
        }
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1, false));
            return;
        }
        const record = value as Record<string, unknown>;
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        const article = types.some(
            (t) =>
                typeof t === 'string' &&
                articleTypes.has(t.replace(/^https?:\/\/schema\.org\//, '')),
        );
        const ids = ['url', '@id', 'mainEntityOfPage']
            .filter((k) => k in record)
            .map((k) => record[k]);
        // An otherwise unidentified top-level Article must match the sole article's heading.
        const bound = ids.length
            ? matches(ids)
            : rootArticle &&
              !!primary &&
              typeof record.headline === 'string' &&
              !!title &&
              record.headline.trim() === title;
        if (article && bound) {
            add('datePublished', record.datePublished, `${path}.datePublished`);
            add('dateModified', record.dateModified, `${path}.dateModified`);
        }
        for (const [k, child] of Object.entries(record))
            if (child && typeof child === 'object') visit(child, `${path}.${k}`, depth + 1, false);
    };
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let total = 0;
    if (scripts.length > 16) overflow = true;
    for (let i = 0; i < Math.min(scripts.length, 16); i++) {
        const text = scripts[i]!.textContent ?? '';
        total += text.length;
        if (text.length > 262144 || total > 524288) {
            overflow = true;
            continue;
        }
        try {
            visit(JSON.parse(text), `jsonld[${i}]$`, 0, true);
        } catch {
            /* Other valid metadata remains usable. */
        }
    }
    const result: ReadPublication = {
        parserVersion: 'scova-publication-v2',
        observations: overflow ? [] : observations,
        status: 'unknown',
        instant: null,
    };
    const { published } = validatePublicationV2(result);
    return { ...result, status: published.status, instant: published.instant };
}
