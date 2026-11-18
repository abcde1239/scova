import type { PlannedRequirement } from '../report/artifacts/index.ts';

import type { Query } from '../research/state.ts';
interface Source {
    title: string;
    url: string;
    originalUrl?: string;
}
export interface RetrievalTarget {
    object: string;
    questionIds: string[];
    fields: string[];
}

/** Retrieval coverage is a discovery heuristic, never a claim of field support. */
export function retrievalTargets(requirements: PlannedRequirement[]): RetrievalTarget[] {
    const targets = new Map<string, RetrievalTarget>();
    for (const requirement of requirements) {
        if (!requirement.required || !requirement.object.trim()) continue;
        const previous = targets.get(requirement.object);
        targets.set(requirement.object, {
            object: requirement.object,
            questionIds: [
                ...new Set([...(previous?.questionIds ?? []), ...requirement.questionIds]),
            ],
            fields: [...new Set([...(previous?.fields ?? []), requirement.field])],
        });
    }
    return [...targets.values()];
}

function words(text: string): string[] {
    return (
        text
            .toLowerCase()
            .replace(/\bnode\.?js\b/g, 'nodejs')
            .match(/[a-z][a-z0-9_+-]*/g) ?? []
    );
}
function hasWord(text: string, word: string): boolean {
    return words(text).includes(word);
}

/** Use the document identity, not navigation text mentioning every sibling module. */
export function matchesRetrievalTarget(target: RetrievalTarget, source: Source): boolean {
    if (!matchesQueryVersion(target.object, source)) return false;
    const identity = `${source.title} ${source.url}`;
    const latin = words(target.object).filter((word) => !/^v\d/.test(word));
    const stem = source.url.match(/\/([^/?#]+)\.(?:html?|md|rst)(?:[?#]|$)/i)?.[1]?.toLowerCase();
    if (stem && latin.some((word) => stem.startsWith(word) && /^\d/.test(stem.slice(word.length))))
        return false;
    if (latin.length) return latin.every((word) => hasWord(identity, word));
    return identity.replace(/\s+/g, '').includes(target.object.replace(/\s+/g, ''));
}

function versions(text: string): string[][] {
    return [
        ...text.matchAll(
            /(?:\bv|\/|["']|\b(?:python|node(?:\.?js)?|vue|postgresql)\s+v?)(\d+(?:\.\d+){0,3})(?=[/\s"'?#]|$)/gi,
        ),
    ].map((match) => match[1]!.split('.'));
}

/** An unspecified version is unknown; an explicitly different version is a contradiction. */
export function matchesQueryVersion(query: string, source: Source): boolean {
    const expected = versions(query);
    const actual = versions(`${source.url} ${source.title}`);
    if (!expected.length || !actual.length) return true;
    return expected.some((left) =>
        actual.some((right) =>
            left
                .slice(0, Math.min(left.length, right.length))
                .every((part, index) => part === right[index]),
        ),
    );
}

export function confirmsRequestedVersion(query: string, source: Source): boolean {
    const identity = `${source.url} ${source.originalUrl ?? ''} ${source.title}`;
    const current =
        /\/current(?:\/|\b)|\bcurrent\s+(?:version|release|docs?|documentation)\b|\b(?:postgresql|python|node(?:\.?js)?|vue)\s+current\b/i;
    if (current.test(query)) return /\/current(?:\/|\b)|\bcurrent\b/i.test(identity);
    if (!versions(query).length) return true;
    return versions(identity).length > 0 && matchesQueryVersion(query, source);
}

/** Recovery queries share the strictest supported search-provider query limit. */
export function boundedRecoveryQuery(query: string, priorities: string[] = []): string {
    const tokens = [...priorities, query].flatMap((part) => part.match(/"[^"]+"|\S+/g) ?? []);
    const selected: string[] = [];
    for (const token of tokens) {
        if (selected.includes(token)) continue;
        if ([...selected, token].join(' ').length <= 100) selected.push(token);
        else if (!selected.length) {
            let prefix = '';
            for (const character of token) {
                if ((prefix + character).length > 100) break;
                prefix += character;
            }
            selected.push(prefix);
        }
    }
    return selected.join(' ');
}

/** A named documentation module cannot be replaced by a sibling module on the same host. */
export function matchesSiteModule(query: string, source: Source): boolean {
    const expressions = [...query.matchAll(/\bsite:(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi)];
    let actual: URL;
    try {
        actual = new URL(source.url);
    } catch {
        return false;
    }
    return expressions.every((expression) => {
        const value = expression[1] ?? expression[2] ?? expression[3]!;
        let expected: URL;
        try {
            expected = new URL(value.includes('://') ? value : `https://${value}`);
        } catch {
            return true;
        }
        const host = (url: URL) => url.hostname.replace(/^www\./i, '');
        if (host(expected) !== host(actual)) return false;
        const left = expected.pathname.match(/\/([^/]+)\.(?:html?|md|rst)$/i)?.[1]?.toLowerCase();
        if (left) {
            const right = actual.pathname
                .replace(/\/$/, '')
                .split('/')
                .at(-1)
                ?.replace(/(?:\.(?:html?|md|rst))+$/i, '')
                .toLowerCase();
            return left === right;
        }
        const namespace = (url: URL) =>
            url.pathname
                .split('/')
                .filter(
                    (part) =>
                        part &&
                        !/^(?:v?\d+(?:\.\d+)*|current|latest|[a-z]{2}(?:-[a-z]{2})?)$/i.test(part),
                );
        const required = namespace(expected);
        const actualParts = namespace(actual);
        return required.every((part, index) => part === actualParts[index]);
    });
}

/** Only remove the path from a site operator, preserving its host and path semantics. */
export function relaxSitePath(query: string): string | null {
    let changed = false;
    const priority: string[] = [];
    const relaxed = query.replace(
        /\bsite:(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi,
        (whole, double, single, bare) => {
            const value = String(double ?? single ?? bare).replace(/[),;，；]+$/, '');
            let url: URL;
            try {
                url = new URL(value.includes('://') ? value : `https://${value}`);
            } catch {
                return whole;
            }
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                !url.hostname ||
                url.pathname === '/'
            )
                return whole;
            const terms = url.pathname
                .split('/')
                .filter(Boolean)
                .map((part) => part.replace(/\.(?:html?|md|rst|php|aspx?)$/i, ''))
                .filter((part) => part && !/^(?:docs?|api|library|reference|index)$/i.test(part));
            changed = true;
            const replacement = `site:${url.host}${terms.map((term) => ` "${term.replace(/["\\]/g, '')}"`).join('')}`;
            priority.push(replacement);
            return replacement;
        },
    );
    if (!changed || priority.join(' ').length > 100) return null;
    const normalized = relaxed.replace(/\s+/g, ' ').trim();
    return normalized.length <= 100 ? normalized : boundedRecoveryQuery(normalized, priority);
}

/** Select complementary question coverage before spending the same bounded plan twice. */
export function diversifyQueries(queries: Query[], targets: RetrievalTarget[] = []): Query[] {
    const remaining = [...queries];
    const ordered: Query[] = [];
    const covered = new Set<string>();
    const coveredObjects = new Set<string>();
    while (remaining.length) {
        const score = (query: Query) =>
            query.questionIds.filter((id) => !covered.has(id)).length * 100 +
            targets.filter(
                (target) =>
                    !coveredObjects.has(target.object) &&
                    matchesRetrievalTarget(target, { title: query.query, url: '' }),
            ).length;
        remaining.sort((left, right) => score(right) - score(left));
        const query = remaining.shift()!;
        if (
            ordered.some((item) => item.query === query.query && item.language === query.language)
        ) {
            const previous = ordered.find(
                (item) => item.query === query.query && item.language === query.language,
            )!;
            previous.questionIds = [...new Set([...previous.questionIds, ...query.questionIds])];
        } else ordered.push({ ...query, questionIds: [...query.questionIds] });
        query.questionIds.forEach((id) => covered.add(id));
        targets
            .filter((target) => matchesRetrievalTarget(target, { title: query.query, url: '' }))
            .forEach((target) => coveredObjects.add(target.object));
    }
    return ordered;
}

export function objectRecoveryQuery(
    topic: string,
    explicitTask: string,
    target: RetrievalTarget,
    targets: RetrievalTarget[],
): string {
    let focus = topic;
    for (const other of targets) {
        if (other.object === target.object) continue;
        // Exact object labels only: never remove substrings such as watch inside watchEffect.
        const escaped = other.object.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        focus = focus.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'gi'), ' ');
    }
    const requestedVersions = [
        ...explicitTask.matchAll(
            /\bv\d+(?:\.\d+){0,3}\b|\b(?:Python|Node(?:\.?js)?|Vue|PostgreSQL)\s+v?\d+(?:\.\d+){0,3}\b/gi,
        ),
    ].map((match) => match[0]);
    const current = /\bcurrent\b/i.test(explicitTask) ? 'current' : '';
    return boundedRecoveryQuery(
        `${focus} ${target.fields.slice(0, 2).join(' ')} 官方文档 原始资料`,
        [requestedVersions.join(' '), current, target.object],
    );
}
