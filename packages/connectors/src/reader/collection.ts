import type { PageCollection, ReadPage } from '../types.ts';

/** Navigation metadata is bounded and untrusted; it never grants evidence support. */
export function validPageLinks(value: unknown): value is ReadPage['links'] {
    return (
        value === undefined ||
        (Array.isArray(value) &&
            value.length <= 80 &&
            value.every((link) => {
                if (
                    !link ||
                    typeof link !== 'object' ||
                    typeof link.url !== 'string' ||
                    link.url.length > 4000 ||
                    typeof link.text !== 'string' ||
                    !link.text.trim() ||
                    link.text.length > 200 ||
                    Object.keys(link).some((k) => k !== 'url' && k !== 'text')
                )
                    return false;
                try {
                    const url = new URL(link.url);
                    return (
                        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
                    );
                } catch {
                    return false;
                }
            }))
    );
}

export function validPageCollection(value: unknown): value is PageCollection | undefined {
    if (value === undefined) return true; // Historical tool outputs have no acquisition receipt.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as PageCollection;
    return (
        item.version === 1 &&
        (item.method === 'html' || item.method === 'browser') &&
        typeof item.complete === 'boolean' &&
        Array.isArray(item.limitations) &&
        item.limitations.length <= 6 &&
        new Set(item.limitations).size === item.limitations.length &&
        item.limitations.every((reason) =>
            [
                'resource_limit',
                'resource_failure',
                'render_timeout',
                'content_restricted',
                'interaction_required',
                'visual_structure',
            ].includes(reason),
        ) &&
        item.complete === (item.limitations.length === 0)
    );
}

export function pageCollectionGaps(pages: Pick<ReadPage, 'collection'>[]): string[] {
    const reasons = new Set(pages.flatMap((page) => page.collection?.limitations ?? []));
    const gaps: string[] = [];
    if (
        ['resource_limit', 'resource_failure', 'render_timeout'].some((reason) =>
            reasons.has(reason as PageCollection['limitations'][number]),
        )
    )
        gaps.push('部分网页渲染或资源加载受限，已保留可核验正文，但不能保证完整查阅');
    if (reasons.has('content_restricted'))
        gaps.push('部分来源仅提供公开摘要或订阅预览，未取得受限全文');
    if (reasons.has('interaction_required'))
        gaps.push('部分网页存在分页或需交互加载的内容，仅采集当前可读部分');
    if (reasons.has('visual_structure'))
        gaps.push('部分来源含图示结构，已保留可读文字，但图形连接与空间关系尚未完整还原');
    return gaps;
}
