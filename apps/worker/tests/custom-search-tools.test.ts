import { expect, it, vi } from 'vite-plus/test';
import { createToolCaller } from '../src/service/agent/tool-call.ts';
import { emptyUsage } from '../src/service/agent/tool-results.ts';
import { customConfigurationHash } from '../../server/src/repo/execution/search-configuration-freeze.ts';
import type {
    AgentRepository,
    AgentReservationInput,
} from '../../server/src/repo/execution/agent.ts';
import type { AgentSessionOptions } from '../src/service/agent/session.ts';
import type { searchConfigurations } from '@scova/db';

it('将自定义源冻结身份纳入读写账本key，且本地Reader仍受15秒上限', async () => {
    const usage = emptyUsage();
    const reserve = vi.fn(async (input: AgentReservationInput) => ({
        toolCallId: input.operationKey,
        attemptNo: 1,
        usage,
        kind: 'reserved' as const,
    }));
    const repository = {
        reserve,
        settle: vi.fn(async () => ({ usage })),
        fail: vi.fn(),
    } as unknown as AgentRepository;
    const identityKeys: string[] = [];
    for (const source of ['a'.repeat(64), 'b'.repeat(64)]) {
        const options = {
            repository,
            context: {
                mode: 'live',
                deadlineAt: new Date(Date.now() + 60_000),
                signal: new AbortController().signal,
            },
            bundle: {
                mode: 'live',
                searchProvider: 'api',
                providerReads: false,
                searchIdentity: source,
                search: {},
            },
        } as unknown as AgentSessionOptions;
        const call = createToolCaller(
            options,
            usage,
            async () => {},
            () => {},
        );
        const invoke = vi.fn(async (context) => {
            expect(context.timeoutMs).toBeLessThanOrEqual(15_000);
            await context.beforeAttempt('read');
            return 'body';
        });
        await call(
            'read-0',
            'read',
            'https://source.example/article',
            { ...usage, pages: 1 },
            invoke,
            () => {},
        );
        identityKeys.push(reserve.mock.calls.at(-1)![0].operationKey);
    }
    expect(identityKeys[0]).not.toBe(identityKeys[1]);
    expect(identityKeys.join()).not.toContain('https://source.example');
});

it('账号修订、模板、密钥改变均改变冻结身份，内置配置保持历史路径', () => {
    const row = {
        id: 'source',
        revision: 1,
        protocol: 'custom_json',
        baseUrl: 'https://source.example/search',
        contentMode: 'reader',
        customTemplate: { method: 'GET' },
        encryptedApiKey: 'encrypted-key',
    } as unknown as typeof searchConfigurations.$inferSelect;
    const original = customConfigurationHash(row, 'api');
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    for (const changed of [
        { ...row, revision: 2 },
        { ...row, encryptedApiKey: 'rotated-key' },
        { ...row, customTemplate: null },
    ])
        expect(customConfigurationHash(changed, 'api')).not.toBe(original);
    expect(customConfigurationHash(row, 'searxng')).toBeNull();
    expect(customConfigurationHash({ ...row, protocol: 'deepseek' }, 'api')).toBeNull();
});
