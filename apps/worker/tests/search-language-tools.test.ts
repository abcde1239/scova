import { expect, it, vi } from 'vite-plus/test';
import { createAgentTools } from '../src/service/agent/tools.ts';
import { createToolCaller } from '../src/service/agent/tool-call.ts';
import { emptyUsage } from '../src/service/agent/tool-results.ts';
import type {
    AgentRepository,
    AgentReservationInput,
} from '../../server/src/repo/execution/agent.ts';
import type { AgentSessionOptions } from '../src/service/agent/session.ts';
import type { SearchProvider } from '@scova/connectors';

it('persists query language in tool identity, reuses matching calls and sends guards to both search modes', async () => {
    for (const searchProvider of ['api', 'searxng'] as const) {
        const outputs = new Map<string, unknown>();
        const usage = emptyUsage();
        const repositoryMock = {
            reserve: vi.fn(async ({ operationKey }: AgentReservationInput) => ({
                toolCallId: operationKey,
                attemptNo: 1,
                usage,
                ...(outputs.has(operationKey)
                    ? { kind: 'reused', output: outputs.get(operationKey) }
                    : { kind: 'reserved' }),
            })),
            settle: vi.fn(
                async ({ toolCallId, output }: { toolCallId: string; output: unknown }) => {
                    outputs.set(toolCallId, output);
                    return { usage };
                },
            ),
            fail: vi.fn(async () => {}),
        };
        const repository = repositoryMock as unknown as AgentRepository;
        const source = vi.fn<SearchProvider['search']>(async (query, options) => {
            await options?.beforeAttempt?.('search');
            await options?.beforeDispatch?.();
            return {
                kind: 'search_results',
                mode: 'live',
                provider: searchProvider === 'api' ? 'tavily' : 'searxng',
                query,
                searchedAt: new Date().toISOString(),
                results: [],
                coverage: {
                    complete: true,
                    gaps: [],
                    unresponsiveEngines: [],
                    receivedResults: 0,
                    returnedResults: 0,
                    discardedResults: 0,
                    totalResults: 0,
                    truncated: false,
                },
            };
        });
        const options = {
            repository,
            bundle: { searchProvider, search: { search: source } },
            context: {
                mode: 'live',
                deadlineAt: new Date(Date.now() + 60000),
                signal: new AbortController().signal,
            },
        } as unknown as AgentSessionOptions;
        const guard = vi.fn(async () => {});
        const call = createToolCaller(options, usage, guard, () => {});
        const tools = createAgentTools(options, usage, call);
        await tools.search('search-0', 'Agent', { language: 'en' });
        await tools.search('search-0', 'Agent', { language: 'en' });
        await tools.search('search-0', 'Agent', { language: 'ja' });
        expect(source).toHaveBeenCalledTimes(2);
        expect(source.mock.calls.map(([, c]) => c?.language)).toEqual(['en', 'ja']);
        const keys = repositoryMock.reserve.mock.calls.map(([input]) => input.operationKey);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[0]);
        expect(guard).toHaveBeenCalled();
    }
});
