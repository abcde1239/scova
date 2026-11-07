import type { Page } from '@playwright/test';

export type AccessibilityFinding = {
    kind: 'name' | 'hidden-focus' | 'form-label' | 'live-status';
    selector: string;
    detail: string;
};

/**
 * Checks the DOM contracts that a screen reader consumes before its platform
 * specific speech layer. It deliberately does not claim to replace NVDA,
 * VoiceOver or TalkBack.
 */
export async function auditInteractiveSemantics(page: Page): Promise<AccessibilityFinding[]> {
    return page.evaluate(() => {
        const findings: AccessibilityFinding[] = [];
        const visible = (element: Element) => {
            const node = element as HTMLElement;
            const style = getComputedStyle(node);
            const bounds = node.getBoundingClientRect();
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                bounds.width > 0 &&
                bounds.height > 0
            );
        };
        const describe = (element: Element) => {
            const node = element as HTMLElement;
            const id = node.id ? `#${node.id}` : '';
            return `${node.tagName.toLowerCase()}${id}`;
        };
        const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const referencedText = (element: Element) =>
            (element.getAttribute('aria-labelledby') ?? '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id))
                .filter((node): node is HTMLElement => !!node)
                .map(text)
                .filter(Boolean)
                .join(' ');
        const accessibleName = (element: Element) => {
            const node = element as HTMLInputElement;
            return (
                element.getAttribute('aria-label')?.trim() ||
                referencedText(element) ||
                (node.labels ? [...node.labels].map(text).filter(Boolean).join(' ') : '') ||
                text(element) ||
                element.getAttribute('title')?.trim() ||
                ''
            );
        };
        const interactive = document.querySelectorAll(
            'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
        );
        for (const element of interactive) {
            if (!visible(element)) continue;
            if (element.closest('[aria-hidden="true"]')) {
                findings.push({
                    kind: 'hidden-focus',
                    selector: describe(element),
                    detail: '可聚焦或交互元素位于 aria-hidden=true 容器内',
                });
            }
            const input = element as HTMLInputElement;
            if (input.tagName === 'INPUT' && input.type === 'hidden') continue;
            if (!accessibleName(element)) {
                findings.push({
                    kind: element.matches('input, textarea, select') ? 'form-label' : 'name',
                    selector: describe(element),
                    detail: '没有可计算的可访问名称',
                });
            }
        }
        for (const element of document.querySelectorAll('[aria-live]')) {
            if (visible(element) && element.getAttribute('aria-live') !== 'off' && !text(element)) {
                findings.push({
                    kind: 'live-status',
                    selector: describe(element),
                    detail: '可见 aria-live 状态区域为空，状态变化无法被读屏播报',
                });
            }
        }
        return findings;
    });
}
