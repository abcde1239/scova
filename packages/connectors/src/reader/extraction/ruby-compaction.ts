import { ConnectorError } from '../../types.ts';

const capacity = () => new ConnectorError('extraction_failed', '网页节点数超过提取限制');
const discarded = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT']);
const voidTags = new Set([
    'AREA',
    'BASE',
    'BR',
    'COL',
    'EMBED',
    'HR',
    'IMG',
    'INPUT',
    'LINK',
    'META',
    'PARAM',
    'SOURCE',
    'TRACK',
    'WBR',
]);
const escapeText = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Losslessly collapse pure ruby annotation wrappers before applying the usual structural cap. */
export function compactRubyMarkup(document: Document): string {
    const fragments: string[] = [];
    const stack: { node: Node; depth: number; closing?: string }[] = [
        { node: document.documentElement, depth: 0 },
    ];
    let visited = 0;
    let sourceElements = 0;
    let retainedElements = 0;
    let size = 0;
    let compacted = false;
    const append = (value: string) => {
        size += value.length;
        if (size > 2 * 1024 * 1024) throw capacity();
        fragments.push(value);
    };
    while (stack.length) {
        const entry = stack.pop()!;
        if (entry.closing) {
            append(entry.closing);
            continue;
        }
        if (++visited > 100_000 || entry.depth > 64) throw capacity();
        if (entry.node.nodeType === 3) {
            append(escapeText(entry.node.nodeValue ?? ''));
            continue;
        }
        if (entry.node.nodeType !== 1) continue;
        const element = entry.node as Element;
        const tag = element.tagName.toUpperCase();
        if (++sourceElements > 50_000) throw capacity();
        if (discarded.has(tag)) continue;
        if (tag === 'RUBY') {
            const pending: { node: Node; depth: number }[] = [
                { node: element, depth: entry.depth },
            ];
            let plainRuby = true;
            let rubyNodes = 0;
            let rubyElements = 0;
            while (pending.length) {
                const child = pending.pop()!;
                if (rubyNodes >= 128) {
                    plainRuby = false;
                    break;
                }
                if (++rubyNodes + visited > 100_000 || child.depth > 64) throw capacity();
                if (child.node.nodeType === 1) {
                    const inline = child.node as Element;
                    rubyElements++;
                    if (
                        !/^(?:RUBY|RB|RP|RT)$/.test(inline.tagName.toUpperCase()) ||
                        (inline !== element && inline.tagName.toUpperCase() === 'RUBY') ||
                        inline.attributes.length
                    )
                        plainRuby = false;
                } else if (child.node.nodeType !== 3) plainRuby = false;
                for (const node of child.node.childNodes)
                    pending.push({ node, depth: child.depth + 1 });
            }
            if (plainRuby) {
                visited += rubyNodes - 1;
                sourceElements += rubyElements - 1;
                if (sourceElements > 50_000) throw capacity();
                append(escapeText(element.textContent ?? ''));
                compacted = true;
                continue;
            }
        }
        if (++retainedElements > 20_000) throw capacity();
        const name = element.localName;
        append('<' + name);
        for (const attribute of element.attributes)
            append(
                ' ' +
                    attribute.name +
                    '="' +
                    escapeText(attribute.value).replace(/"/g, '&quot;') +
                    '"',
            );
        append('>');
        if (voidTags.has(tag)) continue;
        stack.push({ node: element, depth: entry.depth, closing: '</' + name + '>' });
        const children = [...element.childNodes];
        if (visited + children.length > 100_000) throw capacity();
        for (let index = children.length - 1; index >= 0; index--)
            stack.push({ node: children[index], depth: entry.depth + 1 });
    }
    if (!compacted) throw capacity();
    return fragments.join('');
}
