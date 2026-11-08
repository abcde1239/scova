import { describe, expect, it } from 'vite-plus/test';
import {
    TaskDraftInputSchema,
    TaskDraftResponseSchema,
    TaskDraftScopeSchema,
    parseContract,
} from '../src/index.ts';

describe('未保存任务草稿契约', () => {
    it('问答范围有界且保留逐项内容，拒绝非法日期、重复网址和附加权限', () => {
        const scope = {
            goal: '收集公开课程',
            focusPoints: ['费用\n申请条件'],
            exclusions: [],
            sourcePreferences: {
                preferredUrls: ['https://example.edu/course'],
                excludedUrls: [],
                officialOnly: true,
            },
            timeRange: { kind: 'rolling', days: 30 },
            outputFormat: 'list',
            researchMode: 'collection',
        };
        expect(
            parseContract(TaskDraftInputSchema, { inputText: '课程', searchScope: scope })
                .searchScope,
        ).toEqual(scope);
        for (const invalid of [
            { ...scope, goal: ' ' },
            { ...scope, focusPoints: Array(11).fill('内容') },
            {
                ...scope,
                sourcePreferences: {
                    ...scope.sourcePreferences,
                    preferredUrls: ['https://example.edu', 'https://example.edu'],
                },
            },
            {
                ...scope,
                timeRange: {
                    kind: 'fixed',
                    start: '2026-11-08T00:00:00Z',
                    end: '2026-11-01T00:00:00Z',
                },
            },
            { ...scope, agentProviderId: 'invented-permission' },
        ])
            expect(() => parseContract(TaskDraftScopeSchema, invalid)).toThrow();
    });
    it('原始描述不隐式修剪，时区可选但必须合法', () => {
        const input = { inputText: '  每周找材料  ', timezone: 'Asia/Tokyo' };
        expect(parseContract(TaskDraftInputSchema, input)).toBe(input);
        expect(() =>
            parseContract(TaskDraftInputSchema, { inputText: 'x', timezone: 'Mars/Base' }),
        ).toThrow();
        expect(() =>
            parseContract(TaskDraftInputSchema, { inputText: ' ', timezone: 'Asia/Tokyo' }),
        ).toThrow();
        expect(() =>
            parseContract(TaskDraftInputSchema, { inputText: 'x', userId: 'owner' }),
        ).toThrow();
        expect(() =>
            parseContract(TaskDraftInputSchema, { inputText: 'x'.repeat(2001) }),
        ).toThrow();
    });
    it('响应必须使用待确认标识，不能把草稿伪装为已创建任务', () => {
        expect(TaskDraftResponseSchema.properties.requiresConfirmation.const).toBe(true);
        expect(TaskDraftResponseSchema.additionalProperties).toBe(false);
        expect(TaskDraftResponseSchema.properties.parsingUsage.properties.attempts.maximum).toBe(2);
    });
});
