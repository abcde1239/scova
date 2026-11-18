import { serializePageText } from './text.ts';

const auxiliary =
    'nav,aside,footer,form,[role="navigation"],[role="complementary"],script,style,iframe,object,embed,noscript,[hidden],[aria-hidden="true"]';

/** Prefer the publisher's explicit primary region over a prose-length score. */
export function selectPageContent(document: Document): Element | undefined {
    const eligible = (element: Element) => {
        if (element.closest('nav,aside,footer,[role="navigation"],[hidden],[aria-hidden="true"]'))
            return false;
        for (let node: Element | null = element; node; node = node.parentElement) {
            if (
                /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
                    node.getAttribute('style') ?? '',
                )
            )
                return false;
        }
        return !!element.textContent?.trim();
    };
    const choose = (elements: Element[]) => {
        const score = (element: Element) =>
            (element.querySelector('article,[itemprop="articleBody"],.refentry,.main_text')
                ? 8
                : 0) +
            (element.querySelector('h1') ? 4 : 0) +
            (element.querySelector('h2,h3') ? 1 : 0) +
            Math.min(3, Math.log10(Math.max(1, (element.textContent ?? '').trim().length)));
        return elements.filter(eligible).sort((first, second) => score(second) - score(first))[0];
    };
    const semanticMain = choose([...document.querySelectorAll('main,[role="main"]')]);
    if (semanticMain) return semanticMain;
    const candidates = [
        ...document.querySelectorAll(
            '[itemprop="articleBody"],.refentry,[role="document"],.main_text',
        ),
    ];
    const primary = choose(candidates);
    if (primary) return primary;
    // Older publishing systems predate semantic main/article elements. A named
    // content region is still a stronger signal than a long prose footer.
    const contentLength = (element: Element) =>
        (cleanPageContent(element).textContent ?? '').replace(/\s+/g, ' ').trim().length;
    const documentTextLength = contentLength(document.body);
    const conventional = choose(
        [
            ...document.querySelectorAll(
                'div#Main,div#main,div#content,div#Content,div#main-content,div.main-content,table[id$="main" i]',
            ),
        ].filter((element) => {
            // A section may coincidentally be called "content" (RFC 9110 §6.4).
            // A legacy id alone cannot outweigh the rest of the actual document.
            if (element.closest('section,article')) return false;
            const textLength = contentLength(element);
            return textLength >= documentTextLength * 0.25 || !!element.querySelector('h1');
        }),
    );
    if (conventional) return conventional;
    const articles = [...document.querySelectorAll('article')].filter(eligible);
    if (articles.length === 1) return articles[0];
    return undefined;
}

export function cleanPageContent(element: Element): Element {
    const copy = element.cloneNode(true) as Element;
    // Some public-service overview pages express their actual workflow as a
    // description-list navigation inside main. Keep the step explanations;
    // short menus, header links and unrelated navigation remain auxiliary.
    copy.querySelectorAll('nav,[role="navigation"]').forEach((navigation) => {
        if (!navigation.closest('main,article,[role="main"]')) return;
        if (
            navigation.parentElement?.closest(
                'header,nav,aside,footer,[role="navigation"],[role="complementary"],[hidden],[aria-hidden="true"]',
            ) ||
            navigation.closest('[hidden],[aria-hidden="true"]')
        )
            return;
        for (
            let ancestor: Element | null = navigation;
            ancestor;
            ancestor = ancestor.parentElement
        ) {
            if (
                /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
                    ancestor.getAttribute('style') ?? '',
                )
            )
                return;
        }
        const pairs = [...navigation.querySelectorAll('dl')].flatMap((list) => {
            const children = [...list.children];
            return children.flatMap((term, index) => {
                const description = children[index + 1];
                if (
                    term.tagName !== 'DT' ||
                    description?.tagName !== 'DD' ||
                    !term.querySelector('a[href]') ||
                    !(term.textContent ?? '').trim() ||
                    (description.textContent ?? '').replace(/\s+/g, ' ').trim().length < 20
                )
                    return [];
                return [description];
            });
        });
        if (pairs.length < 2) return;
        const section = navigation.ownerDocument.createElement('section');
        while (navigation.firstChild) section.append(navigation.firstChild);
        navigation.replaceWith(section);
    });
    copy.querySelectorAll(auxiliary).forEach((node) => {
        // Scholarly footnotes commonly use aside; they are evidence, unlike a sidebar.
        if (node.matches('[role="doc-footnote"]') || node.querySelector('[role="doc-footnote"]'))
            return;
        node.remove();
    });
    return copy;
}

export function getPageTitle(document: Document, fallback: string): string {
    const title = (document.title ?? '').replace(/\s+/g, ' ').trim();
    // Readability sometimes selects a short brand after a separator (Vue.js).
    // Retain the publisher's title before attempting a derived fallback.
    return title || fallback.trim() || document.querySelector('h1,h2')?.textContent?.trim() || '';
}

export function primaryPageText(document: Document): string | undefined {
    const content = selectPageContent(document);
    return content ? serializePageText(cleanPageContent(content)) || undefined : undefined;
}

/** Preserve public diagram labels before Readability strips graphics. */
export function preparePageFallback(document: Document): void {
    // Readability discards SVG before its fallback prose selection. Replace
    // only the public text labels with a plain text block at the same position;
    // all paths, script and foreign markup stay out of the canonical evidence.
    document.querySelectorAll('svg').forEach((svg) => {
        const labels = serializePageText(svg);
        if (!labels) return;
        const replacement = document.createElement('p');
        replacement.textContent = labels;
        let target: Element = svg;
        const compact = (text: string) => text.replace(/\s+/g, '').trim();
        const sourceText = compact(svg.textContent ?? '');
        // Image-only wrappers are themselves removed by Readability (for
        // example class=imgcontainer). Hoist the safe labels through wrappers
        // with no other prose, but never through a real article/main section.
        for (
            let parent = target.parentElement;
            parent?.tagName === 'DIV';
            parent = target.parentElement
        ) {
            if (
                compact(parent.textContent ?? '') !== sourceText ||
                parent.querySelector('h1,h2,h3,p,pre,table')
            )
                break;
            target = parent;
        }
        target.replaceWith(replacement);
    });
}
