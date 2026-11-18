/** Self-contained so the same check runs in the extractor and Playwright's DOM. */
export function pageIsLoading(
    document: Document = globalThis.document,
    hasScripts = !!document.querySelector('script'),
): boolean {
    const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
    const loading = (value: string) =>
        /^(?:(?:loading(?:\s+(?:the\s+)?(?:page|content|article|data))?|(?:page|content|article|data)\s+is\s+loading|please\s*wait(?:\s+while\s+(?:we\s+)?load(?:\s+(?:the\s+)?(?:page|content|article|data))?)?|(?:页面|网页|内容|正文|文章|数据)?(?:正在)?(?:加载|载入)(?:页面|网页|内容|正文|文章|数据)?中?|请稍[候后]|请耐心等待)[\s.!！。…，,;；:：]*){1,4}$/i.test(
            compact(value),
        );
    if (loading(document.body?.textContent ?? '')) return true;
    const semantic = [...document.querySelectorAll('main,[role="main"]')];
    const regions = semantic.length
        ? semantic
        : [...document.querySelectorAll('#root,#app,#__next,#__nuxt')];
    const auxiliary =
        'nav,header,footer,aside,form,[role="navigation"],[hidden],[aria-hidden="true"]';
    const regionText = (region: Element) => {
        const pending: { node: Node; depth: number }[] = [{ node: region, depth: 0 }];
        const text: string[] = [];
        let count = 0;
        // The extractor budgets elements; whitespace/text are separate DOM nodes.
        // Keep both bounded without rejecting ordinary long API references.
        let elements = 0;
        while (pending.length) {
            const entry = pending.pop()!;
            if (++count > 80_000 || entry.depth > 64) throw new Error('网页节点数超过提取限制');
            const element = entry.node.nodeType === 1 ? (entry.node as Element) : undefined;
            if (element && ++elements > 20_000) throw new Error('网页节点数超过提取限制');
            if (element?.matches(auxiliary + ',script,style,template')) continue;
            if (entry.node.nodeType === 3) text.push(entry.node.textContent ?? '');
            const children = [...entry.node.childNodes];
            if (element?.shadowRoot?.mode === 'open')
                children.push(...element.shadowRoot.childNodes);
            if (count + pending.length + children.length > 80_000)
                throw new Error('网页节点数超过提取限制');
            for (const node of children) pending.push({ node, depth: entry.depth + 1 });
        }
        return compact(text.reverse().join(' '));
    };
    for (const region of regions) {
        if (region.closest(auxiliary)) continue;
        // Busy on the requested main region means that SSR/preview content is
        // explicitly unfinished. An article elsewhere must never certify it.
        if (hasScripts && region.getAttribute('aria-busy') === 'true') return true;
        const articleBodies = [
            ...region.querySelectorAll('article,[itemprop="articleBody"]'),
        ].filter((node) => !node.closest(auxiliary));
        const loadedArticle = articleBodies.some((article) => {
            const text = compact(article.textContent ?? '');
            return text && !loading(text) && article.getAttribute('aria-busy') !== 'true';
        });
        const paragraphs = [
            ...region.querySelectorAll('p,div,span,[role="status"],[aria-busy="true"]'),
        ]
            .filter((node) => !node.closest(auxiliary))
            .map((node) => compact(node.textContent ?? ''))
            .filter(Boolean);
        const text = regionText(region);
        if (!loadedArticle && paragraphs.some((value) => loading(value) && text.startsWith(value)))
            return true;
        if (!text && hasScripts) return true;
    }
    return false;
}
