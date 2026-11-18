import { Type, type Static } from '@sinclair/typebox';
import { describeProperties } from '../common/schema.ts';

const FieldPath = Type.String({ minLength: 1, maxLength: 200 });
export const CustomSearchTemplateSchema = Type.Object(
    {
        method: Type.Union([Type.Literal('GET'), Type.Literal('POST')]),
        languageMap: Type.Optional(
            Type.Record(
                Type.String({ minLength: 2, maxLength: 2 }),
                Type.String({ minLength: 1, maxLength: 32 }),
                { maxProperties: 11 },
            ),
        ),
        auth: Type.Object(
            {
                type: Type.Union([Type.Literal('bearer'), Type.Literal('header')]),
                headerName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
            },
            { additionalProperties: false },
        ),
        request: Type.Record(
            Type.String({ minLength: 1, maxLength: 64 }),
            Type.Union([Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean()]),
            { minProperties: 1, maxProperties: 24 },
        ),
        response: Type.Object(
            {
                resultsPath: FieldPath,
                urlPath: FieldPath,
                titlePath: FieldPath,
                snippetPath: FieldPath,
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false, description: '有限字段的搜索 JSON 映射，不执行代码或表达式' },
);
describeProperties(CustomSearchTemplateSchema);
export type CustomSearchTemplate = Static<typeof CustomSearchTemplateSchema>;

/** Presets contain public protocol metadata only, never credentials. */
export const BRAVE_SEARCH_PRESET = {
    baseUrl: 'https://api.search.brave.com/res/v1/web/search',
    custom: {
        method: 'GET',
        languageMap: { zh: 'zh-hans', pt: 'pt-pt' },
        auth: { type: 'header', headerName: 'X-Subscription-Token' },
        request: { q: '{{query}}', count: '{{count}}', search_lang: '{{language}}' },
        response: {
            resultsPath: 'web.results',
            urlPath: 'url',
            titlePath: 'title',
            snippetPath: 'description',
        },
    },
} satisfies { baseUrl: string; custom: CustomSearchTemplate };
