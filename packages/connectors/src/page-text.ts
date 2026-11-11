import { ConnectorError } from './types.ts';

/** Plain text with source paragraph, cell and code boundaries retained for evidence. */
export function serializePageText(root: Node): string {
    let chunks: string[] = [];
    const segments: { text: string; preformatted: boolean }[] = [];
    const flush = () => {
        if (!chunks.length) return;
        segments.push({ text: chunks.join(''), preformatted: false });
        chunks = [];
    };
    const blocks = new Set([
        'ADDRESS',
        'ARTICLE',
        'BLOCKQUOTE',
        'CAPTION',
        'DD',
        'DETAILS',
        'DIV',
        'DL',
        'DT',
        'FIGCAPTION',
        'FIGURE',
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
        'H6',
        'HEADER',
        'HR',
        'LI',
        'MAIN',
        'OL',
        'P',
        'SECTION',
        'SUMMARY',
        'TABLE',
        'TBODY',
        'THEAD',
        'TFOOT',
        'TR',
        'UL',
    ]);
    const ignored = new Set([
        'SCRIPT',
        'STYLE',
        'IFRAME',
        'OBJECT',
        'EMBED',
        'NOSCRIPT',
        'FOREIGNOBJECT',
        'ANNOTATION',
        'ANNOTATION-XML',
    ]);
    const preformatted = (node: Node): string => {
        if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? '';
        const element = node as Element;
        const tag = element.tagName?.toUpperCase();
        if (
            ignored.has(tag) ||
            element.hasAttribute?.('hidden') ||
            element.getAttribute?.('aria-hidden') === 'true'
        )
            return '';
        if (tag === 'BR') return '\n';
        return [...node.childNodes].map(preformatted).join('');
    };
    const svgLabels = (svg: Element): string[] => {
        const labels: string[] = [];
        const walk = (node: Node, inLabel = false): string => {
            if (node.nodeType === 3)
                return inLabel ? (node.nodeValue ?? node.textContent ?? '') : '';
            if (node.nodeType !== 1) return '';
            const item = node as Element;
            const tag = item.tagName.toUpperCase();
            if (
                ignored.has(tag) ||
                item.hasAttribute('hidden') ||
                item.getAttribute('aria-hidden') === 'true'
            )
                return '';
            if (tag === 'TEXT' || (tag === 'TSPAN' && !inLabel)) {
                const text = [...node.childNodes]
                    .map((child) => walk(child, true))
                    .join('')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (text) labels.push(text);
                return '';
            }
            // Text/tspan contents are ordinary text; graphics, event handlers,
            // paths and foreign HTML never become executable or source prose.
            return [...node.childNodes].map((child) => walk(child, inLabel)).join('');
        };
        walk(svg);
        return labels;
    };
    // Readability's lightweight DOM intentionally has no selectors/closest.
    // Traverse both DOM implementations using their common node interface.
    const descendants = (element: Element, names: Set<string>): Element[] => {
        const found: Element[] = [];
        const walk = (node: Node) => {
            for (const child of node.childNodes) {
                if (child.nodeType !== 1) continue;
                const item = child as Element;
                if (names.has(item.tagName.toUpperCase())) found.push(item);
                walk(item);
            }
        };
        walk(element);
        return found;
    };
    const nearestTable = (node: Node): Element | undefined => {
        for (let current: Node | null = node; current; current = current.parentNode) {
            if ((current as Element).tagName?.toUpperCase() === 'TABLE') return current as Element;
        }
        return undefined;
    };
    const tableText = (table: Element): string => {
        const rows = descendants(table, new Set(['TR'])).filter(
            (row) => nearestTable(row) === table,
        );
        const grid = rows.map(() => new Map<number, string>());
        let expanded = 0;
        const span = (cell: Element, name: string) => {
            const value = Number.parseInt(cell.getAttribute(name) ?? '1', 10);
            return Number.isFinite(value) && value >= 0 ? value : 1;
        };
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
            const row = rows[rowIndex];
            let column = 0;
            const cells = [...row.children].filter((cell) => /^(?:td|th)$/i.test(cell.tagName));
            for (const cell of cells) {
                while (grid[rowIndex].has(column)) column++;
                const width = Math.max(1, span(cell, 'colspan'));
                let groupEnd = rowIndex + 1;
                while (groupEnd < rows.length && rows[groupEnd].parentNode === row.parentNode)
                    groupEnd++;
                const declaredHeight = span(cell, 'rowspan');
                const height =
                    declaredHeight === 0
                        ? groupEnd - rowIndex
                        : Math.min(Math.max(1, declaredHeight), groupEnd - rowIndex);
                if (column + width > 256 || expanded + width * height > 20_000)
                    throw new ConnectorError('extraction_failed', '表格展开结构超过提取限制');
                const value = serializePageText(cell);
                for (let down = 0; down < height; down++) {
                    for (let across = 0; across < width; across++) {
                        const continued = down !== 0 || across !== 0;
                        // A very long spanned cell must not multiply a tiny HTML
                        // table into unbounded text. Keep an explicit reference.
                        grid[rowIndex + down].set(
                            column + across,
                            continued && value.length > 256
                                ? `[same cell as row ${rowIndex + 1}, column ${column + 1}]`
                                : value,
                        );
                        expanded++;
                    }
                }
                column += width;
            }
        }
        const columns = grid.reduce(
            (width, row) => Math.max(width, ...[...row.keys()].map((key) => key + 1)),
            0,
        );
        const field = (value: string) =>
            /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        const caption = [...table.children].find(
            (node) => node.tagName.toUpperCase() === 'CAPTION',
        );
        return [
            ...(caption ? [serializePageText(caption)] : []),
            ...grid.map((row) =>
                Array.from({ length: columns }, (_, column) => field(row.get(column) ?? '')).join(
                    '\t',
                ),
            ),
        ].join('\n');
    };
    const ordinals = new WeakMap<Element, number>();
    const orderedValue = (element: Element, parent: Element) => {
        if (!ordinals.has(element)) {
            const items = [...parent.children].filter(
                (child) => child.tagName.toUpperCase() === 'LI',
            );
            const reverse = parent.hasAttribute('reversed');
            const increment = reverse ? -1 : 1;
            const start = Number.parseInt(parent.getAttribute('start') ?? '', 10);
            let next = Number.isFinite(start) ? start : reverse ? items.length : 1;
            for (const item of items) {
                const explicit = Number.parseInt(item.getAttribute('value') ?? '', 10);
                if (Number.isFinite(explicit)) next = explicit;
                ordinals.set(item, next);
                next += increment;
            }
        }
        return ordinals.get(element) ?? 1;
    };
    const visit = (node: Node) => {
        if (node.nodeType === 3) {
            const value = node.nodeValue ?? node.textContent ?? '';
            chunks.push(value.replace(/\s+/g, ' '));
            return;
        }
        if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
        const element = node as Element;
        const tag = element.tagName?.toUpperCase();
        if (
            ignored.has(tag) ||
            element.hasAttribute?.('hidden') ||
            element.getAttribute?.('aria-hidden') === 'true'
        )
            return;
        if (tag === 'BR') {
            chunks.push('\n');
            return;
        }
        if (tag === 'SVG') {
            const labels = svgLabels(element);
            if (labels.length) chunks.push('\n', ...labels.flatMap((label) => [label, '\n']), '\n');
            return;
        }
        if (tag === 'PRE') {
            chunks.push('\n\n');
            flush();
            // Keep raw code outside all prose whitespace normalization. Tabs,
            // trailing spaces and blank lines can be executable string content.
            segments.push({ text: preformatted(node), preformatted: true });
            chunks.push('\n\n');
            return;
        }
        // Legacy forums use nested tables for layout, including authors and
        // reply metadata. Keep those as blocks; they are not a financial grid.
        const layoutTable =
            tag === 'TABLE' &&
            (element.getAttribute('role') === 'presentation' ||
                (descendants(element, new Set(['TABLE'])).length > 0 &&
                    !descendants(element, new Set(['TH', 'CAPTION'])).some(
                        (cell) => nearestTable(cell) === element,
                    )));
        if (tag === 'TABLE' && !layoutTable) {
            chunks.push('\n\n');
            flush();
            // The TSV grid is already normalized. In particular consecutive
            // tabs encode empty cells and must never be collapsed as prose.
            segments.push({ text: tableText(element), preformatted: true });
            chunks.push('\n\n');
            return;
        }
        const block = blocks.has(tag);
        if (block) chunks.push('\n');
        if (tag === 'LI') {
            const parent = element.parentNode as Element | null;
            const ordered = parent?.tagName?.toUpperCase() === 'OL';
            chunks.push(ordered && parent ? `${orderedValue(element, parent)}. ` : '- ');
        }
        if (tag === 'TD' || tag === 'TH') chunks.push('\t');
        for (const child of node.childNodes) visit(child);
        if (tag === 'TD' || tag === 'TH') chunks.push('\t');
        if (block) chunks.push('\n');
    };
    visit(root);
    flush();
    return segments
        .map((segment, index) => {
            if (segment.preformatted) return segment.text;
            let text = segment.text
                .replace(/\r\n?/g, '\n')
                .replace(/ +/g, ' ')
                .replace(/ *\t */g, '\t')
                .replace(/\t+/g, '\t')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n');
            if (index === 0) text = text.trimStart();
            if (index === segments.length - 1) text = text.trimEnd();
            return text;
        })
        .join('');
}
