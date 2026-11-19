import { describe, expect, it } from 'vite-plus/test';
import { BRAVE_SEARCH_PRESET } from '@scova/models';
import { parseSearchTemplate, searchTemplateDraft } from '@/utils/account/search-template';

describe('custom search editor draft', () => {
    it('round trips the shared Brave preset including provider-specific Chinese language mapping', () => {
        expect(parseSearchTemplate(searchTemplateDraft())).toEqual(BRAVE_SEARCH_PRESET.custom);
    });
    it('preserves an edited POST template, literals and provider response paths', () => {
        const draft = searchTemplateDraft({
            method: 'POST',
            auth: { type: 'bearer' },
            request: { query: '{{query}}', limit: 5, safe: true },
            response: {
                resultsPath: 'payload.items',
                urlPath: 'link',
                titlePath: 'name',
                snippetPath: 'text',
            },
            languageMap: { ja: 'jpn' },
        });
        const parsed = parseSearchTemplate(draft);
        expect(parsed.request).toEqual({ query: '{{query}}', limit: 5, safe: true });
        expect(parsed.auth).toEqual({ type: 'bearer' });
        expect(parsed.response.resultsPath).toBe('payload.items');
        expect(parsed.languageMap).toEqual({ ja: 'jpn' });
    });
    it.each(['{broken', 'null', '[]', '{"q":{"nested":"{{query}}"}}'])(
        'rejects malformed or unsupported JSON request %s before save',
        (requestJson) => {
            expect(() => parseSearchTemplate({ ...searchTemplateDraft(), requestJson })).toThrow();
        },
    );
    it('does not evaluate request text and rejects malformed language mapping', () => {
        const draft = searchTemplateDraft();
        draft.requestJson = '{"q":"{{query}}","literal":"${process.env.SECRET}"}';
        expect(parseSearchTemplate(draft).request.literal).toBe('${process.env.SECRET}');
        draft.languageMapJson = '{"ja":{"nested":true}}';
        expect(() => parseSearchTemplate(draft)).toThrow();
    });
});
