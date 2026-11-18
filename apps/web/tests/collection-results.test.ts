import { describe, expect, it } from 'vite-plus/test';
import type { Report } from '@scova/models';
import { collectionRows, dateSourceLabel } from '@/utils/source-dates';

describe('collection source dates', () => {
    it('joins redirected canonical pages without converting day precision to an instant', () => {
        const report = {
            claims: [
                { id: 'fact', kind: 'fact', text: 'Node.js v1', evidenceIds: ['e1'] },
                { id: 'model', kind: 'model_answer', text: 'draft', evidenceIds: [] },
            ],
            evidence: [
                {
                    id: 'e1',
                    url: 'https://example.test/requested?utm_source=email',
                    snapshot: {
                        originalUrl: 'https://example.test/requested',
                        fetchedUrl: 'https://example.test/releases',
                        canonicalUrl: 'https://example.test/releases?utm_campaign=new#top',
                    },
                },
            ],
            coverage: {
                dateScreening: {
                    entries: [
                        {
                            pageId: 'read-1',
                            url: 'https://example.test/releases',
                            status: 'accepted',
                            publishedAt: null,
                            dateValue: '2026-11-17',
                            dateKind: 'modified',
                            dateSource: 'dateModified',
                        },
                        {
                            pageId: 'read-2',
                            url: 'https://example.test/requested',
                            status: 'unconfirmed',
                            publishedAt: null,
                            dateSource: null,
                        },
                    ],
                },
            },
        } as unknown as Report;
        const before = structuredClone(report);
        const rows = collectionRows(report);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.pages).toHaveLength(1);
        expect(rows[0]?.pages[0]).toMatchObject({
            publishedAt: null,
            dateValue: '2026-11-17',
            dateKind: 'modified',
        });
        expect(dateSourceLabel(rows[0]?.pages[0]?.dateSource)).toBe('页面更新时间');
        expect(report).toEqual(before);
    });
});
