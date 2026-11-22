import { describe, expect, it, vi } from 'vite-plus/test';
import { ConnectorError } from '@scova/connectors';
import { AgentPersistenceError } from '../../server/src/repo/execution/agent.ts';
import { createToolCaller } from '../src/service/agent/tool-call.ts';
import { emptyUsage } from '../src/service/agent/tool-results.ts';

describe('trusted tool reservation errors', () => {
    it.each(['BUDGET_EXCEEDED', 'INVALID_TOOL_CALL', 'MODEL_QUOTA_EXCEEDED'] as const)(
        'classifies %s before provider dispatch',
        async (code) => {
            const error = new AgentPersistenceError(code);
            const reserve = vi.fn(async () => {
                throw error;
            });
            const invalidateBudget = vi.fn();
            const call = createToolCaller(
                { repository: { reserve }, bundle: {} } as unknown as Parameters<
                    typeof createToolCaller
                >[0],
                emptyUsage(),
                async () => {},
                invalidateBudget,
            );
            const invoke = vi.fn(async () => 'must not dispatch');
            const pending = call('search-0', 'search', 'query', emptyUsage(), invoke, () => {});
            if (code === 'INVALID_TOOL_CALL') await expect(pending).rejects.toBe(error);
            else {
                await expect(pending).rejects.toBeInstanceOf(ConnectorError);
                await expect(pending).rejects.toMatchObject({
                    code: code === 'BUDGET_EXCEEDED' ? 'budget_exceeded' : 'model_quota_exceeded',
                });
            }
            expect(invalidateBudget).not.toHaveBeenCalled();
            expect(invoke).not.toHaveBeenCalled();
        },
    );
});
