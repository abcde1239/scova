import type { AgentClaim } from '@scova/agent-core';

/** A short overview from already validated conclusions; never splice a sentence mid-output. */
export function reportSummary(claims: AgentClaim[]): string {
    const preferred = claims.some((claim) => claim.kind === 'inference')
        ? claims.filter((claim) => claim.kind === 'inference')
        : claims;
    const paragraphs: string[] = [];
    let length = 0;
    for (const claim of preferred) {
        const text = claim.text.trim();
        const size = Array.from(text).length;
        if (paragraphs.includes(text) || length + size > 600) continue;
        paragraphs.push(text);
        length += size;
        if (paragraphs.length === 3) break;
    }
    return paragraphs.join('\n\n') || '已整理来源与结论，请查看下方正文和引用。';
}
