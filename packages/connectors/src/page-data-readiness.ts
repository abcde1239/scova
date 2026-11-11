/** Self-contained for extraction and Playwright's DOM; ordinary prose is not a loading state. */
export function pageHasPendingData(document: Document = globalThis.document): boolean {
    const primary = document.querySelector('main,[role="main"]') ?? document.body;
    const fields =
        primary?.querySelectorAll(
            '[data-json-replace],[data-bind],[data-ajax-replace],[data-ajax-append],[data-ajax-prepend],[role="status"],[role="alert"],output,.loading-error,.load-error',
        ) ?? [];
    return [...fields].some((node) => {
        if (
            node.closest(
                'nav,header,footer,aside,form,pre,code,blockquote,[role="navigation"],[hidden],[aria-hidden="true"]',
            )
        )
            return false;
        for (let element: Element | null = node; element; element = element.parentElement) {
            if (
                /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
                    element.getAttribute('style') ?? '',
                )
            )
                return false;
        }
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text.length > 300) return false;
        return /^\[?(?:(?:error|failed)(?:\s+(?:while\s+)?(?:loading|retrieving|fetching)|\s+to\s+(?:load|retrieve|fetch))\b|unable\s+to\s+(?:load|retrieve|fetch)\b|(?:数据|费用|价格|内容)(?:加载|获取)失败)/i.test(
            text,
        );
    });
}
