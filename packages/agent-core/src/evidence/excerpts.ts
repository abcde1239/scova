import { bilingualRetrievalTerms, retrievalTermMatcher } from '../search/retrieval-terms.ts';

export interface ExcerptRange {
    start: number;
    end: number;
}
const generic = new Set(
    'the and for with from this that into are was were has have how what which using use official documentation document docs reference source sources compare comparison public interfaces module modules api information conditions limitations'.split(
        ' ',
    ),
);

function terms(text: string): string[] {
    const compound = text.toLowerCase().match(/\b[a-z_]\w*(?:\.[a-z_]\w*)+\b/g) ?? [];
    const latin = (text.toLowerCase().match(/[a-z][a-z0-9_]{1,63}/g) ?? []).filter(
        (term) => !generic.has(term),
    );
    const han = [...text.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(([word]) =>
        Array.from({ length: Math.min(12, word.length - 1) }, (_, index) =>
            word.slice(index, index + 2),
        ),
    );
    return [...new Set([...compound, ...latin, ...bilingualRetrievalTerms(text), ...han])].slice(
        0,
        48,
    );
}
function apiHeading(text: string): string | null {
    const heading = text.trim().replace(/^#{1,6}\s+/, '');
    if (heading.length > 600 || heading.split('\n').length > 6) return null;
    return (
        heading
            .match(
                /^(?:(?:class|static)?method\s+)?([a-z_]\w*(?:\.[a-z_]\w*)*)\s*\([\s\S]*\)\s*[¶:]?$/i,
            )?.[1]
            ?.toLowerCase() ?? null
    );
}
function merge(ranges: ExcerptRange[]): ExcerptRange[] {
    const result: ExcerptRange[] = [];
    for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
        const previous = result.at(-1);
        if (previous && range.start <= previous.end)
            previous.end = Math.max(previous.end, range.end);
        else result.push({ ...range });
    }
    return result;
}
const size = (ranges: ExcerptRange[]) =>
    ranges.reduce((sum, range) => sum + range.end - range.start, 0);

/** Precompute lexical matches once; fitting never creates a model call or a generated summary. */
export function sourceExcerptSelector(text: string, focus: string[] = []) {
    const characters = Array.from(text);
    const groups = focus
        .slice(0, 80)
        .map(terms)
        .filter((group) => group.length);
    const vocabulary = [...new Set(groups.flat())].slice(0, 256);
    const matchers = new Map(vocabulary.map((term) => [term, retrievalTermMatcher(term)]));
    const anchors = vocabulary.filter((term) => term.includes('.'));
    const boundaries = [
        0,
        ...[...text.matchAll(/\n[ \t]*\n+/g)].map((match) => match.index + match[0].length),
        text.length,
    ];
    const blocks: (ExcerptRange & {
        terms: Set<string>;
        groups: Set<number>;
        substantive: boolean;
        definitionAnchors: Set<string>;
    })[] = [];
    for (let index = 1; index < boundaries.length; index++) {
        const start = boundaries[index - 1]!;
        const end = boundaries[index]!;
        if (end <= start) continue;
        // Very large paragraphs may contain many complete prose sentences or code lines.
        const pieces = [start];
        if (end - start > 2400) {
            const body = text.slice(start, end);
            let previous = start;
            for (const match of body.matchAll(/[。！？]|[.!?](?=\s|$)|\n/g)) {
                const boundary = start + match.index + match[0].length;
                if (boundary - previous >= 600) {
                    pieces.push(boundary);
                    previous = boundary;
                }
            }
        }
        pieces.push(end);
        for (let part = 1; part < pieces.length; part++) {
            const from = pieces[part - 1]!;
            const to = pieces[part]!;
            const body = text.slice(from, to).toLowerCase();
            const prose = body
                .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
                .replace(/https?:\/\/\S+/g, '');
            const substantive =
                /[。！？]|\b(?:is|are|was|were|returns?|sets?|defines?|specifies|allows?|must|means|only|unless|except|between)\b|[.!?](?=\s|$)/i.test(
                    prose,
                ) &&
                (prose.match(/[a-z]{2,}/g)?.length ?? 0) +
                    (prose.match(/[\p{Script=Han}]/gu)?.length ?? 0) >=
                    4;
            const hits = new Set(vocabulary.filter((term) => matchers.get(term)!(body)));
            blocks.push({
                start: from,
                end: to,
                substantive,
                definitionAnchors: new Set<string>(),
                terms: hits,
                groups: new Set(
                    groups.flatMap((group, groupIndex) =>
                        group.some((term) => hits.has(term)) ? [groupIndex] : [],
                    ),
                ),
            });
        }
    }
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        const anchor = apiHeading(text.slice(block.start, block.end));
        if (!anchor || !anchors.includes(anchor) || !blocks[index + 1]?.substantive) continue;
        // Prefer the requested API's actual definition and bounded local explanation over
        // references to it in sibling APIs, examples or a table of contents.
        for (let next = index; next < Math.min(blocks.length, index + 12); next++) {
            const entry = blocks[next]!;
            if (
                entry.end - block.start > 4096 ||
                (next > index && apiHeading(text.slice(entry.start, entry.end)))
            )
                break;
            entry.definitionAnchors.add(anchor);
            entry.terms.add(anchor);
            groups.forEach((group, groupIndex) => {
                if (group.includes(anchor)) entry.groups.add(groupIndex);
            });
        }
    }
    for (let index = 1; index < blocks.length; index++) {
        const block = blocks[index]!;
        const previous = blocks[index - 1]!;
        const heading = text.slice(previous.start, previous.end).trim();
        if (
            block.substantive &&
            !previous.substantive &&
            heading.length <= 320 &&
            heading.split('\n').filter(Boolean).length <= 2 &&
            /^(?:#{1,6}\s|(?:class(?:method)?\s+)?[a-z_][\w.]*\s*(?:\(|$))/i.test(heading)
        ) {
            previous.terms.forEach((term) => block.terms.add(term));
            previous.groups.forEach((group) => block.groups.add(group));
        }
    }
    const frequencies = new Map(
        vocabulary.map((term) => [term, blocks.filter((block) => block.terms.has(term)).length]),
    );
    const offset = (position: number) =>
        characters.length === text.length
            ? position
            : characters.slice(0, position).join('').length;
    const fallback = (limit: number) => {
        const third = Math.floor(limit / 3);
        const middle = Math.floor((characters.length - third) / 2);
        return merge(
            [
                [0, third],
                [middle, middle + third],
                [characters.length - third, characters.length],
            ].map(([start, end]) => ({ start: offset(start!), end: offset(end!) })),
        );
    };
    return {
        length: characters.length,
        select(limit: number): {
            excerpts: string[];
            excerptRanges: ExcerptRange[];
            offsetUnit: 'utf16';
        } {
            let selected: ExcerptRange[] = [];
            const covered = new Set<number>();
            const coveredAnchors = new Set<string>();
            const remaining = blocks
                .map((block, index) => ({ ...block, index }))
                .filter((block) => block.terms.size);
            const windowLimit = Math.min(12, Math.max(6, groups.length * 2));
            while (remaining.length && selected.length < windowLimit) {
                const score = (block: (typeof remaining)[number]) =>
                    [...block.definitionAnchors].reduce(
                        (sum, anchor) => sum + (coveredAnchors.has(anchor) ? 8 : 64),
                        0,
                    ) +
                    ([...block.groups].filter((group) => !covered.has(group)).length * 4 +
                        [...block.terms].reduce(
                            (sum, term) =>
                                sum +
                                (term.includes('.') ? 4 : 1) /
                                    Math.sqrt(frequencies.get(term) ?? 1),
                            0,
                        )) *
                        (block.substantive ? 1 : 0.08);
                remaining.sort(
                    (left, right) => score(right) - score(left) || left.start - right.start,
                );
                const block = remaining.shift()!;
                if (selected.some((range) => range.start <= block.start && range.end >= block.end))
                    continue;
                let window: ExcerptRange = { start: block.start, end: block.end };
                if (size(merge([...selected, window])) > limit) continue;
                const neighbors = [blocks[block.index - 1], blocks[block.index + 1]].filter(
                    (neighbor) => !!neighbor,
                );
                const conditional = (neighbor: ExcerptRange) =>
                    /\b(?:only|unless|except|however|if|when|must|not|before|after)\b|仅|除非|例外|但是|注意|不支持|限制|条件|同步|异步/i.test(
                        text.slice(neighbor.start, neighbor.end),
                    );
                neighbors.sort(
                    (left, right) => Number(conditional(right)) - Number(conditional(left)),
                );
                for (const neighbor of neighbors) {
                    const expanded = {
                        start: Math.min(window.start, neighbor.start),
                        end: Math.max(window.end, neighbor.end),
                    };
                    const allowance = conditional(neighbor)
                        ? limit
                        : Math.max(block.end - block.start, Math.floor(limit / 2));
                    if (
                        expanded.end - expanded.start <= allowance &&
                        size(merge([...selected, expanded])) <= limit
                    )
                        window = expanded;
                }
                selected = merge([...selected, window]);
                for (const included of blocks.filter(
                    (entry) => entry.start >= window.start && entry.end <= window.end,
                )) {
                    included.groups.forEach((group) => covered.add(group));
                    if (included.substantive)
                        included.definitionAnchors.forEach((anchor) => coveredAnchors.add(anchor));
                }
            }
            if (!selected.length) selected = fallback(limit);
            return {
                excerpts: selected.map((range) => text.slice(range.start, range.end)),
                excerptRanges: selected,
                offsetUnit: 'utf16',
            };
        },
    };
}
