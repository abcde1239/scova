import { deferred } from './support/deferred';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import {
    ReportSchema,
    ReportQuestionSchema,
    RunSchema,
    parseContract,
    type Report,
    type ReportQuestion,
    type Run,
    type SessionResponse,
} from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    followupAttempt,
    followupEndpoint,
    followupParent,
    followupRun,
    requestFollowup,
} from '@/api/followup';
import { runQueryOptions } from '@/api/runs';
import { useFollowup } from '@/composable/useFollowup';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-31T00:00:00Z';
const text = '  还需要什么已保存资料？\n保持原问题  ';
function reportFixture(mode: 'demo' | 'live' = 'live'): Report {
    return parseContract(ReportSchema, {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '原报告',
        summary: '有限覆盖',
        format: 'brief',
        mode,
        outcome: 'inconclusive',
        coverage: { completeness: 'partial', searchedQueries: [], gaps: ['缺口'], exhausted: [] },
        limitations: ['有限证据'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '保存原文',
                confidenceLabel: '原文',
                evidenceIds: [id(20)],
            },
        ],
        evidence: [
            {
                id: id(20),
                sourceId: id(21),
                snapshotId: id(22),
                title: '来源',
                url: 'https://example.test/source',
                quote: '保存原文',
                location: '第一段',
                observedAt: time,
            },
        ],
        changes: [],
        publishedAt: time,
    });
}
function questionFixture(): ReportQuestion {
    return parseContract(ReportQuestionSchema, {
        id: id(30),
        reportId: id(1),
        question: text,
        answer: {
            status: 'insufficient',
            statements: [],
            reason: 'model_unavailable',
            needsResearch: true,
            usage: { attempts: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        },
        followupRunId: null,
        createdAt: time,
    });
}
function parentFixture(mode: 'demo' | 'live' = 'live'): Run {
    return parseContract(RunSchema, {
        id: id(3),
        taskId: id(2),
        taskVersionId: id(4),
        parentRunId: null,
        baselineRunId: null,
        mode,
        status: 'partial',
        trigger: 'manual',
        outcome: 'inconclusive',
        budget: {
            maxSearches: 3,
            maxPages: 7,
            maxDurationSeconds: 90,
            maxInputTokens: 2000,
            maxOutputTokens: 1000,
        },
        usage: { searches: 1, pages: 1, inputTokens: 0, outputTokens: 0, estimated: false },
        coverage: {
            completeness: 'partial',
            searchedQueries: [],
            gaps: ['有限证据'],
            exhausted: [],
        },
        queuedAt: time,
        startedAt: time,
        finishedAt: time,
        failureCode: null,
    });
}
function nextFixture(status: Run['status'] = 'queued', mode: 'demo' | 'live' = 'live'): Run {
    return parseContract(RunSchema, {
        ...parentFixture(mode),
        id: id(40),
        parentRunId: id(3),
        trigger: 'followup',
        status,
        outcome: null,
        coverage:
            status === 'succeeded'
                ? { completeness: 'complete', searchedQueries: [], gaps: [], exhausted: [] }
                : status === 'partial'
                  ? parentFixture().coverage
                  : null,
        finishedAt: ['succeeded', 'partial', 'failed', 'canceled'].includes(status) ? time : null,
    });
}
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'reader@example.test',
        createdAt: time,
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
    },
    csrfToken: 'sample-csrf',
};
const disposals: (() => void)[] = [];
function mount(
    fetcher?: typeof fetch,
    initialQuestion = questionFixture(),
    initialReport: Report | undefined = reportFixture(),
) {
    const calls = vi.fn<typeof fetch>(
        fetcher ??
            (async (url) =>
                Response.json(
                    urlText(url).endsWith(`/runs/${id(3)}`) ? parentFixture() : nextFixture(),
                )),
    );
    const lifecycle = createSessionLifecycle({ fetcher: calls });
    lifecycle.replaceSession(account);
    const report = ref<Report | undefined>(initialReport),
        question = ref<ReportQuestion | undefined>(initialQuestion),
        reportId = ref(id(1)),
        questionId = ref(id(30));
    const scope = effectScope();
    const state = scope.run(() => useFollowup(reportId, questionId, report, question, lifecycle))!;
    disposals.push(lifecycle.dispose, () => scope.stop());
    return {
        state,
        lifecycle,
        report,
        question,
        reportId,
        questionId,
        calls,
        stop: () => scope.stop(),
    };
}
const urlText = (value: RequestInfo | URL) =>
    typeof value === 'string' ? value : value instanceof Request ? value.url : value.toString();
const command = (run = nextFixture(), reused = false, status = 202) =>
    Response.json({ run, reused }, { status });
const failure = (status: number, code = 'TEST_FAILURE') =>
    Response.json({ code, message: 'sample', requestId: 'sample' }, { status });
async function open(state: ReturnType<typeof useFollowup>) {
    state.open();
    await vi.waitFor(() => expect(state.parent.value).toBeDefined());
}
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
});

describe('followup contract and frozen parent identity', () => {
    it('freezes original question, mode/version/budget/key and rejects a parent unrelated to the report', () => {
        const parent = parentFixture('live');
        const attempt = followupAttempt(
            reportFixture('live'),
            questionFixture(),
            parent,
            'stable-followup-key-1234',
        );
        expect(attempt.question).toBe(text);
        expect(attempt.mode).toBe('live');
        expect(attempt.parentRunId).toBe(id(3));
        expect(Object.isFrozen(attempt)).toBe(true);
        expect(Object.isFrozen(attempt.budget)).toBe(true);
        parent.budget.maxPages = 9;
        expect(attempt.budget.maxPages).toBe(7);
        expect(() => followupParent({ ...parent, id: id(50) }, reportFixture('live'))).toThrow();
        expect(() =>
            followupAttempt(
                reportFixture(),
                { ...questionFixture(), reportId: id(55) },
                parentFixture(),
            ),
        ).toThrow();
    });
    it.each([
        { taskId: id(50) },
        { taskVersionId: id(50) },
        { parentRunId: id(50) },
        { mode: 'demo' },
        { trigger: 'manual' },
        { id: id(3) },
        { budget: { ...parentFixture().budget, maxPages: 9 } },
    ])('rejects mismatched followup identity even if reused %#', (patch) => {
        const attempt = followupAttempt(reportFixture(), questionFixture(), parentFixture());
        expect(() => followupRun({ ...nextFixture(), ...patch } as Run, attempt)).toThrow();
    });
    it('uses exact confirm:true, one unified same-origin POST with CSRF and stable key; no config or mode payload', async () => {
        const { lifecycle, calls } = mount(async () => command());
        const attempt = followupAttempt(
            reportFixture(),
            questionFixture(),
            parentFixture(),
            'stable-followup-key-1234',
        );
        await requestFollowup(lifecycle.capture(), attempt, new AbortController().signal);
        const [url, init] = calls.mock.calls[0]!;
        expect(urlText(url)).toBe(`/api/v1/reports/${id(1)}/questions/${id(30)}/followup`);
        expect(init?.method).toBe('POST');
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('sample-csrf');
        expect(new Headers(init?.headers).get('idempotency-key')).toBe(attempt.key);
        expect(JSON.parse(init?.body as string)).toEqual({ confirm: true });
    });
    it.each([{}, { confirm: false }, { confirm: true, mode: 'live' }])(
        'rejects non-explicit/extra payload before any transport %j',
        async (body) => {
            const { lifecycle, calls } = mount();
            await expect(
                lifecycle.capture().request(
                    followupEndpoint,
                    {
                        params: { reportId: id(1), questionId: id(30) },
                        body: body as { confirm: true },
                    },
                    { idempotencyKey: 'stable-followup-key-1234' },
                ),
            ).rejects.toThrow();
            expect(calls).not.toHaveBeenCalled();
        },
    );
    it.each([200, 201])('does not accept a non202 command HTTP%s', async (status) => {
        const { lifecycle } = mount(async () => command(nextFixture(), false, status));
        await expect(
            requestFollowup(
                lifecycle.capture(),
                followupAttempt(reportFixture(), questionFixture(), parentFixture()),
                new AbortController().signal,
            ),
        ).rejects.toThrow();
    });
    it('enforces a known question association and first queued state', async () => {
        const attempt = followupAttempt(reportFixture(), questionFixture(), parentFixture());
        const { lifecycle } = mount(async () => command(nextFixture('running')));
        await expect(
            requestFollowup(lifecycle.capture(), attempt, new AbortController().signal),
        ).rejects.toThrow();
        expect(() => followupRun(nextFixture(), attempt, id(80))).toThrow();
    });
});

describe('explicit confirmation and original Run read', () => {
    it('makes no request before open and no POST after open/cancel/reopen, keeping the original budget', async () => {
        const { state, calls } = mount();
        await nextTick();
        expect(calls).not.toHaveBeenCalled();
        await open(state);
        expect(calls.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
        expect(state.parent.value?.budget).toEqual(parentFixture().budget);
        state.close();
        expect(state.attempt.value).toBeUndefined();
        expect(state.opened.value).toBe(false);
        await state.confirm();
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
        await open(state);
        state.close();
        expect(state.protectedState.value).toBe(false);
    });
    it.each([{ taskId: id(8) }, { taskVersionId: id(8) }, { mode: 'demo' }, { id: id(8) }])(
        'blocks confirmation on an invalid original Run %#',
        async (patch) => {
            const { state, calls } = mount(async () =>
                Response.json({ ...parentFixture(), ...patch }),
            );
            state.open();
            await vi.waitFor(() => expect(state.parentQuery.isError.value).toBe(true));
            expect(state.parent.value).toBeUndefined();
            await state.confirm();
            expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
        },
    );
    it('allows a saved completed answer with needsResearch=false without auto authorizing', async () => {
        const question = questionFixture();
        question.answer = {
            status: 'answered',
            statements: [
                { text: '保存原文', citations: [{ evidenceId: id(20), quote: '保存原文' }] },
            ],
            reason: 'evidence_answer',
            needsResearch: false,
            usage: question.answer.usage,
        };
        const { state, calls } = mount(undefined, question);
        expect(state.canOpen.value).toBe(true);
        await open(state);
        state.close();
        expect(calls.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    });
    it('freezes only on final explicit confirm, blocks duplicate clicks and preserves live', async () => {
        const ack = deferred<Response>();
        const { state, calls } = mount(async (url, init) =>
            init?.method === 'POST'
                ? ack.promise
                : Response.json(
                      urlText(url).endsWith(`/runs/${id(3)}`) ? parentFixture() : nextFixture(),
                  ),
        );
        await open(state);
        const sending = state.confirm();
        await vi.waitFor(() =>
            expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1),
        );
        await state.confirm();
        await state.replay();
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
        expect(state.attempt.value?.mode).toBe('live');
        expect(state.protectedState.value).toBe(true);
        state.close();
        expect(state.opened.value).toBe(true);
        ack.resolve(command());
        await sending;
        expect(state.phase.value).toBe('success');
        expect(state.opened.value).toBe(false);
        expect(state.linkedId.value).toBe(id(40));
        expect(state.protectedState.value).toBe(false);
        expect(state.canOpen.value).toBe(false);
    });
    it.each([
        'queued',
        'running',
        'recovering',
        'cancel_requested',
        'succeeded',
        'partial',
        'failed',
        'canceled',
    ] as const)(
        'accepts a genuine reused %s Run without calling it a new active execution',
        async (status) => {
            const run = nextFixture(status);
            const { state } = mount(async (url, init) =>
                init?.method === 'POST'
                    ? command(run, true)
                    : Response.json(
                          urlText(url).endsWith(`/runs/${id(3)}`) ? parentFixture() : run,
                      ),
            );
            await open(state);
            await state.confirm();
            expect(state.phase.value).toBe('success');
            expect(state.message.value).toContain('复用');
            await vi.waitFor(() => expect(state.linkedRun.value?.status).toBe(status));
        },
    );
    it('already linked question performs GET-only validation and offers no second execution action', async () => {
        const question = { ...questionFixture(), followupRunId: id(40) };
        const { state, calls } = mount(undefined, question);
        await vi.waitFor(() => expect(state.linkedRun.value?.id).toBe(id(40)));
        expect(state.canOpen.value).toBe(false);
        state.open();
        await state.confirm();
        expect(calls.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
    });
});

describe('unknown writes, preserved identity and explicit recovery', () => {
    it.each([408, 500, 503])(
        'keeps original key after HTTP%s and replays only on explicit action',
        async (status) => {
            let writes = 0;
            const { state, calls } = mount(async (url, init) =>
                init?.method === 'POST'
                    ? ++writes === 1
                        ? failure(status)
                        : command()
                    : Response.json(
                          urlText(url).endsWith(`/runs/${id(3)}`) ? parentFixture() : nextFixture(),
                      ),
            );
            await open(state);
            await state.confirm();
            expect(state.phase.value).toBe('uncertain');
            const frozen = state.attempt.value;
            await nextTick();
            expect(writes).toBe(1);
            expect(state.protectedState.value).toBe(true);
            await state.replay();
            expect(state.attempt.value).toBe(frozen);
            const posts = calls.mock.calls.filter((call) => call[1]?.method === 'POST');
            expect(
                posts.map((call) => new Headers(call[1]?.headers).get('idempotency-key')),
            ).toEqual([frozen!.key, frozen!.key]);
            expect(posts.map((call) => call[1]?.body)).toEqual([
                '{"confirm":true}',
                '{"confirm":true}',
            ]);
            expect(state.phase.value).toBe('success');
        },
    );
    it.each([
        'network',
        'wrong-parent',
        'wrong-mode',
        'wrong-budget',
        'wrong-status',
        'bad-schema',
    ] as const)('keeps unknown attempt for %s after dispatch', async (kind) => {
        const { state } = mount(async (url, init) => {
            if (init?.method !== 'POST')
                return Response.json(
                    urlText(url).endsWith(`/runs/${id(3)}`) ? parentFixture() : nextFixture(),
                );
            if (kind === 'network') throw new TypeError('lost ack');
            if (kind === 'bad-schema')
                return Response.json({ run: {}, reused: true }, { status: 202 });
            return command(
                {
                    ...nextFixture(),
                    ...(kind === 'wrong-parent'
                        ? { parentRunId: id(99) }
                        : kind === 'wrong-mode'
                          ? { mode: 'demo' as const }
                          : kind === 'wrong-budget'
                            ? { budget: { ...parentFixture().budget, maxPages: 9 } }
                            : { status: 'running' as const }),
                },
                kind !== 'wrong-status',
            );
        });
        await open(state);
        await state.confirm();
        expect(state.phase.value).toBe('uncertain');
        expect(state.attempt.value?.key).toBeTruthy();
        expect(state.protectedState.value).toBe(true);
    });
    it('reads known question GET only; null association does not unlock or replace key', async () => {
        const { state, calls } = mount(async (url, init) =>
            init?.method === 'POST'
                ? failure(503)
                : Response.json(
                      urlText(url).includes('/questions/') ? questionFixture() : parentFixture(),
                  ),
        );
        await open(state);
        await state.confirm();
        const frozen = state.attempt.value;
        await state.recover();
        expect(state.phase.value).toBe('uncertain');
        expect(state.attempt.value).toBe(frozen);
        expect(state.canOpen.value).toBe(false);
        expect(state.message.value).toContain('不能证明');
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    });
    it('recovers a saved nonnull association using GETs, validates actual Run and never replays POST', async () => {
        const { state, calls } = mount(async (url, init) =>
            init?.method === 'POST'
                ? failure(503)
                : Response.json(
                      urlText(url).includes('/questions/')
                          ? { ...questionFixture(), followupRunId: id(40) }
                          : urlText(url).endsWith(`/runs/${id(3)}`)
                            ? parentFixture()
                            : nextFixture('failed'),
                  ),
        );
        await open(state);
        await state.confirm();
        await state.recover();
        expect(state.phase.value).toBe('success');
        expect(state.linkedId.value).toBe(id(40));
        expect(state.protectedState.value).toBe(false);
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    });
    it('does not accept recovery question with changed text or a mismatched linked Run', async () => {
        let badQuestion = true;
        const { state } = mount(async (url, init) =>
            init?.method === 'POST'
                ? failure(503)
                : Response.json(
                      urlText(url).includes('/questions/')
                          ? {
                                ...questionFixture(),
                                question: badQuestion ? 'changed' : text,
                                followupRunId: id(40),
                            }
                          : urlText(url).endsWith(`/runs/${id(3)}`)
                            ? parentFixture()
                            : { ...nextFixture(), mode: 'demo' },
                  ),
        );
        await open(state);
        await state.confirm();
        const key = state.attempt.value?.key;
        await state.recover();
        expect(state.phase.value).toBe('uncertain');
        expect(state.linkedId.value).toBe('');
        badQuestion = false;
        await state.recover();
        expect(state.phase.value).toBe('uncertain');
        expect(state.attempt.value?.key).toBe(key);
    });
    it.each([
        'RUN_ALREADY_ACTIVE',
        'TASK_ARCHIVED',
        'TASK_VERSION_MISSING',
        'FOLLOWUP_UNAVAILABLE',
    ])('rejects definite409 %s without navigation or automatic cancellation', async (code) => {
        const { state, calls } = mount(async (_url, init) =>
            init?.method === 'POST' ? failure(409, code) : Response.json(parentFixture()),
        );
        await open(state);
        await state.confirm();
        expect(state.phase.value).toBe('rejected');
        expect(state.linkedId.value).toBe('');
        expect(state.attempt.value).toBeUndefined();
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    });
    it('keeps pending idempotency uncertain but blocks payload mismatch without rotating the key', async () => {
        let code = 'IDEMPOTENCY_PENDING';
        const { state, calls } = mount(async (_url, init) =>
            init?.method === 'POST' ? failure(409, code) : Response.json(parentFixture()),
        );
        await open(state);
        await state.confirm();
        expect(state.phase.value).toBe('uncertain');
        const key = state.attempt.value?.key;
        code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        await state.replay();
        expect(state.phase.value).toBe('blocked');
        expect(state.attempt.value?.key).toBe(key);
        await state.replay();
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(2);
        expect(state.protectedState.value).toBe(true);
    });
    it('preserves same-owner unknown attempt through temporary report/question read failures', async () => {
        const { state, report, question, calls } = mount(async (_url, init) =>
            init?.method === 'POST' ? failure(503) : Response.json(parentFixture()),
        );
        await open(state);
        await state.confirm();
        const frozen = state.attempt.value;
        report.value = undefined;
        question.value = undefined;
        expect(state.available.value).toBe(false);
        expect(state.attempt.value).toBe(frozen);
        expect(state.protectedState.value).toBe(true);
        await state.replay();
        expect(calls.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
        report.value = reportFixture();
        question.value = questionFixture();
        await vi.waitFor(() => expect(state.available.value).toBe(true));
        expect(state.attempt.value).toBe(frozen);
        expect(state.phase.value).toBe('uncertain');
    });
    it.each(['owner', 'report', 'question', 'dispose'] as const)(
        'isolates %s change and late successful command',
        async (change) => {
            const ack = deferred<Response>();
            const { state, lifecycle, reportId, questionId, stop, calls } = mount(
                async (_url, init) =>
                    init?.method === 'POST' ? ack.promise : Response.json(parentFixture()),
            );
            await open(state);
            const sending = state.confirm();
            await vi.waitFor(() =>
                expect(calls.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(true),
            );
            if (change === 'owner')
                lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
            else if (change === 'report') reportId.value = id(99);
            else if (change === 'question') questionId.value = id(99);
            else stop();
            ack.resolve(command());
            await sending;
            expect(state.confirmedId.value).toBe('');
            expect(state.attempt.value).toBeUndefined();
            expect(state.message.value).not.toContain('已创建');
        },
    );
    it('does not install an older command snapshot over an authoritative Run cache', async () => {
        const ack = deferred<Response>();
        const { state, lifecycle } = mount(async (url, init) =>
            init?.method === 'POST'
                ? ack.promise
                : Response.json(
                      urlText(url).endsWith(`/runs/${id(3)}`)
                          ? parentFixture()
                          : nextFixture('succeeded'),
                  ),
        );
        await open(state);
        const sending = state.confirm();
        const options = runQueryOptions(lifecycle, id(40));
        lifecycle.queryClient.setQueryData(options.queryKey, {
            data: nextFixture('succeeded'),
            status: 200,
            headers: {},
            url: '/runs',
        });
        ack.resolve(command());
        await sending;
        await vi.waitFor(() => expect(state.linkedRun.value?.status).toBe('succeeded'));
        expect(
            lifecycle.queryClient.getQueryData<{ data: Run }>(options.queryKey)?.data.status,
        ).toBe('succeeded');
    });
});

it('历史演示报告可核验，但不能创建新的演示后续研究', async () => {
    expect(followupParent(parentFixture('demo'), reportFixture('demo')).mode).toBe('demo');
    expect(() =>
        followupAttempt(reportFixture('demo'), questionFixture(), parentFixture('demo')),
    ).toThrow();
    const { state, calls } = mount(undefined, questionFixture(), reportFixture('demo'));
    state.open();
    await state.confirm();
    expect(state.canOpen.value).toBe(false);
    expect(calls).not.toHaveBeenCalled();
});

it('历史演示问题已有的关联仍可按原模式读取', async () => {
    const question = { ...questionFixture(), followupRunId: id(40) };
    const { state, calls } = mount(
        async (url) =>
            Response.json(
                urlText(url).endsWith('/' + id(3))
                    ? parentFixture('demo')
                    : nextFixture('succeeded', 'demo'),
            ),
        question,
        reportFixture('demo'),
    );
    await vi.waitFor(() => expect(state.linkedRun.value?.mode).toBe('demo'));
    expect(calls.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
});
