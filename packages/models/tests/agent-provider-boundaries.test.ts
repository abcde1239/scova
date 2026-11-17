import { describe, expect, it } from 'vite-plus/test';
import {
    AgentProviderInputSchema,
    AgentProviderUpdateSchema,
    AgentProviderActivationSchema,
    parseContract,
} from '../src/index.ts';

const model = {
    name: '研究模型',
    model: 'model-a',
    protocol: 'openai_json',
    baseUrl: 'https://model.example/v1',
    apiKey: 'model-key',
};

describe('模型配置与搜索配置的写入边界', () => {
    it.each([
        { webSearch: 'disabled' },
        { webSearch: 'openai_responses' },
        { searchApi: null },
        {
            searchApi: {
                protocol: 'tavily',
                baseUrl: 'https://api.tavily.com',
                apiKey: 'independent-search-key',
                contentMode: 'reader',
            },
        },
    ])('模型新增和更新不接受搜索字段 %j', (search) => {
        expect(() => parseContract(AgentProviderInputSchema, { ...model, ...search })).toThrow();
        expect(() =>
            parseContract(AgentProviderUpdateSchema, { ...model, revision: 1, ...search }),
        ).toThrow();
    });

    it('模型密钥可单独新增或保留，两个模型用途继续独立', () => {
        expect(parseContract(AgentProviderInputSchema, model)).toEqual(model);
        const { apiKey: _key, ...unchangedKey } = model;
        expect(parseContract(AgentProviderUpdateSchema, { ...unchangedKey, revision: 2 })).toEqual({
            ...unchangedKey,
            revision: 2,
        });
        for (const purpose of ['task_draft', 'research'])
            expect(parseContract(AgentProviderActivationSchema, { revision: 1, purpose })).toEqual({
                revision: 1,
                purpose,
            });
    });
});
