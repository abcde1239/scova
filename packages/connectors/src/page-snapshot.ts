/** Self-contained for Playwright evaluation; reads only open shadow roots. */
export function pageSnapshot(includeMarkup = false): {
    text: string;
    parsed: boolean;
    article: boolean;
    markup?: string;
} {
    const plan: { source: Node; parent: number }[] = [];
    const stack: { source: Node; parent: number; depth: number; body: boolean; hidden: boolean }[] =
        [{ source: document.documentElement, parent: -1, depth: 0, body: false, hidden: false }];
    let count = 0;
    // Match the extractor's element quota, with a separate total topology bound.
    let elements = 0;
    let article = false;
    const text: string[] = [];
    while (stack.length) {
        const entry = stack.pop()!;
        if (++count > 80_000 || entry.depth > 64) throw new Error('网页节点数超过提取限制');
        const element = entry.source.nodeType === 1 ? (entry.source as Element) : undefined;
        if (element && ++elements > 20_000) throw new Error('网页节点数超过提取限制');
        const body = entry.body || element?.tagName.toLowerCase() === 'body';
        const hidden =
            entry.hidden ||
            !!element?.matches('script,style,template,[hidden],[aria-hidden="true"]');
        if (body && !hidden && element?.tagName.toLowerCase() === 'article') article = true;
        if (body && !hidden && entry.source.nodeType === 3)
            text.push(entry.source.textContent ?? '');
        const parent = plan.length;
        plan.push({ source: entry.source, parent: entry.parent });
        const children = [...entry.source.childNodes];
        if (element?.shadowRoot?.mode === 'open') children.push(...element.shadowRoot.childNodes);
        if (
            count + stack.length + children.length > 80_000 ||
            (children.length && entry.depth >= 64)
        )
            throw new Error('网页节点数超过提取限制');
        const pending = children.map((source) => ({
            source,
            parent,
            depth: entry.depth + 1,
            body,
            hidden,
        }));
        stack.push(...pending.reverse());
    }
    let markup: string | undefined;
    if (includeMarkup) {
        // Validate the entire topology before allocating any clone nodes.
        const detached = document.implementation.createHTMLDocument('');
        const targets: Node[] = [];
        for (const entry of plan) {
            const target = detached.importNode(entry.source, false);
            targets.push(target);
            if (entry.parent >= 0) targets[entry.parent]!.appendChild(target);
        }
        markup = '<!doctype html>' + (targets[0] as Element).outerHTML;
    }
    return {
        text: text.join(' ').trim(),
        parsed: document.readyState !== 'loading',
        article,
        ...(markup ? { markup } : {}),
    };
}
