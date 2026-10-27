import { describe, expect, it } from 'vite-plus/test';
import { TaskDraftInputSchema, TaskDraftResponseSchema, parseContract } from '../src/index.ts';

describe('未保存任务草稿契约', () => {
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
