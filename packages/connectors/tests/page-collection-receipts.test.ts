import { describe, expect, it } from 'vite-plus/test';
import { pageCollectionGaps, validPageCollection } from '../src/reader/collection.ts';
import type { PageCollection } from '../src/types.ts';

describe('content acquisition limitations', () => {
    it.each(['content_restricted', 'interaction_required', 'visual_structure'] as const)(
        'requires a partial receipt for %s',
        (reason) => {
            const collection: PageCollection = {
                version: 1,
                method: 'html',
                complete: false,
                limitations: [reason],
            };
            expect(validPageCollection(collection)).toBe(true);
            expect(validPageCollection({ ...collection, complete: true })).toBe(false);
            expect(pageCollectionGaps([{ collection }])).toHaveLength(1);
            expect(pageCollectionGaps([{ collection }])[0]).not.toContain('资源加载');
        },
    );

    it('keeps resource, access and interaction gaps distinct without duplicates', () => {
        const collection: PageCollection = {
            version: 1,
            method: 'browser',
            complete: false,
            limitations: [
                'resource_limit',
                'resource_failure',
                'render_timeout',
                'content_restricted',
                'interaction_required',
                'visual_structure',
            ],
        };
        expect(validPageCollection(collection)).toBe(true);
        expect(pageCollectionGaps([{ collection }, { collection }])).toEqual([
            '部分网页渲染或资源加载受限，已保留可核验正文，但不能保证完整查阅',
            '部分来源仅提供公开摘要或订阅预览，未取得受限全文',
            '部分网页存在分页或需交互加载的内容，仅采集当前可读部分',
            '部分来源含图示结构，已保留可读文字，但图形连接与空间关系尚未完整还原',
        ]);
        expect(
            validPageCollection({
                ...collection,
                limitations: ['interaction_required', 'interaction_required'],
            }),
        ).toBe(false);
    });

    it('accepts historical absent receipts without inventing new acquisition claims', () => {
        expect(validPageCollection(undefined)).toBe(true);
        expect(pageCollectionGaps([{}])).toEqual([]);
    });
});
