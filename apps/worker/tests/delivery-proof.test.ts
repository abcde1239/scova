import { describe, expect, it } from 'vite-plus/test';
import type { AgentCandidate, AgentContext } from '@scova/agent-core';
import type { Run, ToolCall } from '@scova/db';

import {
    finalizeCoverage,
    type DeliveryProof,
} from '../../server/src/service/execution/delivery-proof.ts';

const url = 'https://example.com/a';

function input(options: {
    policy?: boolean;
    completeness?: 'complete' | 'partial';
    deadline?: boolean;
}) {
    const candidate = {
        pages: [
            {
                id: 'read-0',
                url,
                originalUrl: url,
                questionIds: ['q0'],
                truncated: true,
            },
        ],
        claims: [],
        coverage: {
            completeness: options.completeness ?? 'complete',
            searchedQueries: [],
            gaps: [],
            exhausted: [],
        },
    } as unknown as AgentCandidate;
    const proof: DeliveryProof = {
        candidate,
        deadline: !!options.deadline,
        research: {
            ...(options.policy ? { answerCompletionPolicy: 1 } : {}),
            queries: [{ query: 'react', questionIds: ['q0'] }],
            searches: [],
            selections: [{ url, questionIds: ['q0'] }],
        },
    };
    const failedRead = {
        tool: 'read',
        status: 'failed',
        operationKey: 'read-1',
        attemptNo: 1,
    } as unknown as ToolCall;
    const run = { mode: 'live' } as Run;
    const config = { sourcePreferences: { officialOnly: false } } as AgentContext['config'];
    return { candidate, run, config, proof, calls: [failedRead], successful: [] as ToolCall[] };
}

const finalize = (i: ReturnType<typeof input>) =>
    finalizeCoverage(i.candidate, i.run, i.config, i.proof, i.calls, i.successful);
const processItems = [
    '存在已截断正文，无法保证完整查阅',
    '存在失败或结果未确认的工具调用',
    '搜索计划未完成',
    '部分计划查询未取得成功结果',
];

describe('delivery completion with answered coverage', () => {
    it('reports collection limits as notes once every question is answered', () => {
        const i = input({ policy: true });
        finalize(i);
        expect(i.candidate.coverage.completeness).toBe('complete');
        expect(i.candidate.coverage.gaps).toEqual([]);
        expect(i.candidate.coverage.notes).toEqual(expect.arrayContaining(processItems));
    });

    it('keeps collection limits as gaps for legacy checkpoints', () => {
        const i = input({});
        finalize(i);
        expect(i.candidate.coverage.completeness).toBe('partial');
        expect(i.candidate.coverage.gaps).toEqual(expect.arrayContaining(processItems));
    });

    it('does not upgrade an unanswered candidate', () => {
        const i = input({ policy: true, completeness: 'partial' });
        finalize(i);
        expect(i.candidate.coverage.completeness).toBe('partial');
        expect(i.candidate.coverage.gaps).toEqual(expect.arrayContaining(processItems));
    });

    it('keeps a deadline delivery partial', () => {
        const i = input({ policy: true, deadline: true });
        finalize(i);
        expect(i.candidate.coverage.completeness).toBe('partial');
    });

    it.each(['unknown', 'running', 'reserved'] as const)(
        'blocks completion for a %s tool result',
        (status) => {
            const i = input({ policy: true });
            i.calls[0]!.status = status;
            finalize(i);
            expect(i.candidate.coverage.completeness).toBe('partial');
            expect(i.candidate.coverage.gaps).toContain('存在结果未确认的工具调用');
        },
    );

    it('records a recovered failure only as a note', () => {
        const i = input({ policy: true });
        i.successful.push({ ...i.calls[0]!, status: 'succeeded', attemptNo: 2 });
        i.calls.push(i.successful[0]!);
        finalize(i);
        expect(i.candidate.coverage.completeness).toBe('complete');
        expect(i.candidate.coverage.notes).toContain(
            '临时工具故障已在原预算内重试恢复，相关成功结果已核验',
        );
    });
});
