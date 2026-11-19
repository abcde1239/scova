import { deferred } from './support/deferred';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { effectScope, nextTick, ref } from 'vue';
import {
    ReportSchema,
    ReportQuestionSchema,
    parseContract,
    type Report,
    type ReportQuestion,
    type SessionResponse,
} from '@scova/models';
import { createSessionLifecycle } from '@/api/session';
import {
    createReportQuestionEndpoint,
    reportQuestionEndpoint,
    reportConversationEndpoint,
} from '@/api/report-questions';
import { useReportQuestions } from '@/composable/useReportQuestions';
import {
    questionAttempt,
    questionReasons,
    questionResponse,
    questionRetryAt,
    questionSelection,
    questionTextError,
    validateQuestion,
} from '@/utils/report/questions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rawQuestion = '  保存的原文\n有什么？  ';
function reportFixture(): Report {
    return parseContract(ReportSchema, {
        id: id(1),
        taskId: id(2),
        runId: id(3),
        taskVersionId: id(4),
        baselineRunId: null,
        schemaVersion: 1,
        title: '研究报告',
        summary: '有限证据',
        format: 'brief',
        mode: 'demo',
        outcome: 'inconclusive',
        coverage: {
            completeness: 'partial',
            searchedQueries: [],
            gaps: ['资料不全'],
            exhausted: [],
        },
        limitations: ['有限证据'],
        claims: [
            {
                id: id(10),
                kind: 'fact',
                text: '保存的原文',
                confidenceLabel: '原文摘录',
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
                quote: '<script>保存的原文</script>\n第二段逐字原文',
                location: '第一段',
                observedAt: '2026-10-31T00:00:00Z',
            },
        ],
        changes: [],
        publishedAt: '2026-10-31T00:00:00Z',
    });
}
function resultFixture(question = rawQuestion): ReportQuestion {
    return parseContract(ReportQuestionSchema, {
        id: id(30),
        reportId: id(1),
        question,
        answer: {
            status: 'answered',
            statements: [
                {
                    text: '保存的原文',
                    citations: [{ evidenceId: id(20), quote: '<script>保存的原文</script>' }],
                },
            ],
            reason: 'evidence_answer',
            needsResearch: true,
            usage: { attempts: 1, inputTokens: 120, outputTokens: 30, estimated: false },
        },
        followupRunId: null,
        createdAt: '2026-10-31T01:00:00Z',
    });
}
const account: SessionResponse = {
    user: {
        id: id(100),
        email: 'qa@example.test',
        preferences: {
            defaultTimezone: 'UTC',
            notificationPreference: { mode: 'summary', runIssues: true },
        },
        createdAt: '2026-10-31T00:00:00Z',
    },
    csrfToken: 'test-only',
};
const disposals: (() => void)[] = [];
function setup(fetcher: typeof fetch) {
    const lifecycle = createSessionLifecycle({ fetcher });
    lifecycle.replaceSession(account);
    disposals.push(lifecycle.dispose);
    return lifecycle;
}
function mount(
    fetcher: typeof fetch,
    selection?: unknown,
    initialReport: Report | null = reportFixture(),
    conversation: unknown = { reportId: id(1), turns: [], hasEarlier: false },
) {
    const lifecycle = setup(async (input, init) =>
        (typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        ).endsWith('/conversation')
            ? Response.json(conversation)
            : fetcher(input, init),
    );
    const conversationOptions = lifecycle.queryOptions(
        reportConversationEndpoint,
        { params: { reportId: id(1) }, query: {} },
        ['report-conversation', id(1)],
    );
    lifecycle.queryClient.setQueryData(conversationOptions.queryKey, {
        pages: [{ data: { reportId: id(1), turns: [], hasEarlier: false }, status: 200 }],
        pageParams: [undefined],
    });
    lifecycle.queryClient.setQueryDefaults(conversationOptions.queryKey, { staleTime: Infinity });
    const report = ref<Report>();
    report.value = initialReport ?? undefined;
    const reportId = ref(id(1));
    const selected = ref(selection);
    const scope = effectScope();
    const state = scope.run(() => useReportQuestions(reportId, report, selected, lifecycle))!;
    disposals.push(() => scope.stop());
    return { state, lifecycle, report, reportId, selected };
}
function failure(status: number, code = 'TEST_FAILURE', retryAfter?: string) {
    return Response.json(
        { code, message: 'sample', requestId: 'sample' },
        { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
    );
}
afterEach(() => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
});

describe('report-question input and evidence contracts', () => {
    it.each(['', ' ', '\n\t', 'x'.repeat(2001), '😀'.repeat(1001)])(
        'rejects illegal raw question %s',
        (value) => {
            expect(questionTextError(value)).not.toBe('');
            expect(() => questionAttempt(id(1), value)).toThrow();
        },
    );
    it.each(['x'.repeat(2000), '😀'.repeat(1000), rawQuestion])(
        'retains valid UTF-16 boundary and whitespace',
        (value) => {
            expect(questionTextError(value)).toBe('');
            const attempt = questionAttempt(id(1), value, 'stable-test-key-1234');
            expect(attempt.question).toBe(value);
            expect(Object.isFrozen(attempt)).toBe(true);
        },
    );
    it('accepts only one UUID query and no question text or arbitrary URL', () => {
        expect(questionSelection(undefined)).toEqual({});
        expect(questionSelection(id(30))).toEqual({ id: id(30) });
        for (const value of [
            null,
            '',
            [id(30)],
            [id(30), id(30)],
            '../answer',
            'https://example.test',
        ])
            expect(questionSelection(value).error).toBeTruthy();
    });
    it('accepts authorized literal text, answered+needsResearch, and independent usage without altering report', () => {
        const report = reportFixture();
        const before = structuredClone(report);
        const result = resultFixture();
        expect(validateQuestion(result, report, { id: id(30), question: rawQuestion })).toBe(
            result,
        );
        expect(result.answer.needsResearch).toBe(true);
        expect(result.answer.usage).toEqual({
            attempts: 1,
            inputTokens: 120,
            outputTokens: 30,
            estimated: false,
        });
        expect(report).toEqual(before);
    });
    it.each([
        'insufficient_evidence',
        'model_unavailable',
        'model_failed',
        'invalid_output',
        'aborted',
    ] as const)('shows honest insufficient reason %s', (reason) => {
        const result = resultFixture();
        result.answer = {
            status: 'insufficient',
            statements: [],
            reason,
            needsResearch: true,
            usage: { attempts: 0, inputTokens: 0, outputTokens: 0, estimated: false },
        };
        expect(
            validateQuestion(parseContract(ReportQuestionSchema, result), reportFixture()),
        ).toBeTruthy();
        expect(questionReasons[reason]).toBeTruthy();
    });
    it.each([
        'report',
        'question-id',
        'question-text',
        'status',
        'reason',
        'empty-answered',
        'insufficient-statements',
        'needsResearch',
        'evidence',
        'source-id',
        'quote',
        'noncontinuous',
        'blank-quote',
        'statement',
        'blank-statement',
    ])('rejects semantically invalid %s even when shared DTO permits it', (kind) => {
        const result = resultFixture();
        const expected = { id: id(30), question: rawQuestion };
        const statement = result.answer.statements[0]!;
        const citation = statement.citations[0]!;
        if (kind === 'report') result.reportId = id(99);
        if (kind === 'question-id') result.id = id(99);
        if (kind === 'question-text') result.question = rawQuestion.trim();
        if (kind === 'status') result.answer.status = 'insufficient';
        if (kind === 'reason') result.answer.reason = 'model_failed';
        if (kind === 'empty-answered') result.answer.statements = [];
        if (kind === 'insufficient-statements') {
            result.answer.status = 'insufficient';
            result.answer.reason = 'insufficient_evidence';
        }
        if (kind === 'needsResearch') {
            result.answer.status = 'insufficient';
            result.answer.reason = 'insufficient_evidence';
            result.answer.statements = [];
            result.answer.needsResearch = false;
        }
        if (kind === 'evidence') citation.evidenceId = id(99);
        if (kind === 'source-id') citation.evidenceId = id(21);
        if (kind === 'quote') citation.quote = '伪造的原文';
        if (kind === 'noncontinuous') citation.quote = '保存的原文第二段';
        if (kind === 'blank-quote') citation.quote = ' ';
        if (kind === 'statement') statement.text = '不在引用中的自由总结';
        if (kind === 'blank-statement') statement.text = ' ';
        parseContract(ReportQuestionSchema, result);
        expect(() => validateQuestion(result, reportFixture(), expected)).toThrow();
    });
    it('requires exact GET200 and POST201, including completed same-key replay', () => {
        const response = { data: resultFixture(), headers: {}, url: '/sample', status: 201 };
        expect(questionResponse(response, reportFixture(), { question: rawQuestion }, 201)).toBe(
            response,
        );
        expect(() => questionResponse(response, reportFixture())).toThrow();
        expect(() =>
            questionResponse({ ...response, status: 200 }, reportFixture(), {}, 201),
        ).toThrow();
    });
});

describe('actual requestlane report question endpoints', () => {
    it('sends original body, Cookie/CSRF and stable key; GET only reads explicit ID', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            Response.json(resultFixture(), { status: init?.method === 'POST' ? 201 : 200 }),
        );
        const lifecycle = setup(fetcher);
        const scope = lifecycle.capture();
        const attempt = questionAttempt(id(1), rawQuestion, 'stable-test-key-1234');
        await scope.request(
            createReportQuestionEndpoint,
            { params: { reportId: id(1) }, body: { question: attempt.question } },
            { idempotencyKey: attempt.key },
        );
        await scope.request(reportQuestionEndpoint, {
            params: { reportId: id(1), questionId: id(30) },
        });
        const [url, init] = fetcher.mock.calls[0]!;
        expect(url).toContain(`/api/v1/reports/${id(1)}/questions`);
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('test-only');
        expect(new Headers(init?.headers).get('idempotency-key')).toBe(attempt.key);
        expect(typeof init?.body === 'string' && JSON.parse(init.body)).toEqual({
            question: rawQuestion,
        });
        expect(fetcher.mock.calls[1]?.[0]).toContain(`/questions/${id(30)}`);
    });
    it.each(['missing', 'extra', 'invalid-json'])('rejects malformed response %s', async (kind) => {
        const result: Record<string, unknown> = { ...resultFixture() };
        if (kind === 'missing') delete result.answer;
        if (kind === 'extra') result.reused = true;
        const lifecycle = setup(async () =>
            kind === 'invalid-json'
                ? new Response('{bad', { headers: { 'content-type': 'application/json' } })
                : Response.json(result),
        );
        await expect(
            lifecycle.capture().request(reportQuestionEndpoint, {
                params: { reportId: id(1), questionId: id(30) },
            }),
        ).rejects.toThrow();
    });
    it('validates params and question before any transport call', async () => {
        const fetcher = vi.fn<typeof fetch>();
        const lifecycle = setup(fetcher);
        await expect(
            lifecycle
                .capture()
                .request(
                    createReportQuestionEndpoint,
                    { params: { reportId: '../bad' }, body: { question: 'q' } },
                    { idempotencyKey: 'stable-test-key-1234' },
                ),
        ).rejects.toThrow();
        await expect(
            lifecycle
                .capture()
                .request(
                    createReportQuestionEndpoint,
                    { params: { reportId: id(1) }, body: { question: ' ' } },
                    { idempotencyKey: 'stable-test-key-1234' },
                ),
        ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['2', '0', 'Sat, 31 Oct 2026 10:00:00 GMT', '-1', '1.2', 'nonsense'])(
        'uses only actual legal Retry-After %s',
        async (value) => {
            const lifecycle = setup(async () => failure(429, 'RATE_LIMITED', value));
            let cause: unknown;
            try {
                await lifecycle
                    .capture()
                    .request(
                        createReportQuestionEndpoint,
                        { params: { reportId: id(1) }, body: { question: rawQuestion } },
                        { idempotencyKey: 'stable-test-key-1234' },
                    );
            } catch (error) {
                cause = error;
            }
            const now = Date.parse('2026-10-31T09:00:00Z');
            const actual = questionRetryAt(cause, now);
            if (value === '2') expect(actual).toBe(now + 2000);
            else if (value === '0') expect(actual).toBe(now);
            else if (value.startsWith('Sat,')) expect(actual).toBe(Date.parse(value));
            else expect(actual).toBeUndefined();
        },
    );
});

describe('report-question action and owner lifecycle', () => {
    it.each(['wrong-root', 'duplicate', 'wrong-question'])(
        'rejects invalid continuation metadata: %s',
        async (kind) => {
            const turn = { ...resultFixture(), followupRunId: id(40) };
            const continuation = {
                runId: id(41),
                rootRunId: id(40),
                questionId: turn.id,
                operation: 'research',
            };
            if (kind === 'wrong-root') continuation.rootRunId = id(99);
            if (kind === 'wrong-question') continuation.questionId = id(99);
            const { state } = mount(async () => Response.json(turn), undefined, reportFixture(), {
                reportId: id(1),
                turns: [turn],
                hasEarlier: false,
                continuations: kind === 'duplicate' ? [continuation, continuation] : [continuation],
            });
            await state.conversation.refetch();
            await vi.waitFor(() => expect(state.conversation.isError.value).toBe(true));
            expect(state.conversationData.value).toBeUndefined();
            expect(state.canSubmit.value).toBe(false);
        },
    );
    it.each([429, 503])(
        'reads a persisted insufficient result after initial HTTP%s without claiming another model call',
        async (status) => {
            let calls = 0;
            const saved = resultFixture();
            saved.answer = {
                status: 'insufficient',
                statements: [],
                reason: 'model_failed',
                needsResearch: true,
                usage: { attempts: 1, inputTokens: 800, outputTokens: 100, estimated: true },
            };
            const fetcher = vi.fn<typeof fetch>(async () => {
                calls++;
                return calls === 1
                    ? failure(status, 'QUESTION_LIMITED', '0')
                    : Response.json(saved, { status: 201 });
            });
            const { state } = mount(fetcher);
            state.draft.value = rawQuestion;
            await state.submit();
            expect(state.notice.value).toContain('可能已保存');
            const original = state.attempt.value;
            expect(await state.recover()).toBe(id(30));
            expect(state.answer.value?.answer.status).toBe('insufficient');
            expect(state.answer.value?.answer.usage.estimated).toBe(true);
            expect(state.draft.value).toBe('');
            expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(
                original?.key,
            );
            expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'POST']);
        },
    );
    it('honors actual Retry-After and never automatically replays', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => failure(429, 'QUESTION_LIMITED', '3600'));
        const { state } = mount(fetcher);
        state.draft.value = rawQuestion;
        await state.submit();
        expect(state.waiting.value).toBe(true);
        expect(state.canRecover.value).toBe(false);
        await state.recover();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(state.attempt.value?.question).toBe(rawQuestion);
    });
    it.each(['id', 'report', 'quote'])(
        'refuses invalid known-ID GET %s without exposing the saved question',
        async (kind) => {
            const result = resultFixture();
            if (kind === 'id') result.id = id(99);
            if (kind === 'report') result.reportId = id(99);
            if (kind === 'quote') result.answer.statements[0]!.citations[0]!.quote = '伪造的原文';
            const { state } = mount(async () => Response.json(result), id(30));
            await vi.waitFor(() => expect(state.query.isError.value).toBe(true));
            expect(state.answer.value).toBeUndefined();
            expect(state.readError.value).toContain('核验失败');
        },
    );
    it('submits once, installs validated result only in Query, and restores known ID by GET', async () => {
        const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
            Response.json(resultFixture(), { status: init?.method === 'POST' ? 201 : 200 }),
        );
        const { state, selected } = mount(fetcher);
        state.draft.value = rawQuestion;
        expect(await state.submit()).toBe(id(30));
        expect(state.answer.value?.id).toBe(id(30));
        expect(state.attempt.value).toBeUndefined();
        expect(state.protectedState.value).toBe(false);
        selected.value = id(30);
        await nextTick();
        expect(fetcher).toHaveBeenCalledTimes(1);
        await state.recover();
        expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET']);
    });
    it.each([408, 500, 429, 503, 409])(
        'keeps exact immutable attempt after HTTP%s and only explicit replay reads saved result',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
                fetcher.mock.calls.length === 1
                    ? failure(status, status === 409 ? 'QUESTION_PENDING' : 'TEST_FAILURE', '0')
                    : Response.json(resultFixture(), {
                          status: init?.method === 'POST' ? 201 : 200,
                      }),
            );
            const { state } = mount(fetcher);
            state.draft.value = rawQuestion;
            await state.submit();
            const attempt = state.attempt.value;
            expect(attempt?.question).toBe(rawQuestion);
            expect(state.answer.value).toBeUndefined();
            expect(state.protectedState.value).toBe(true);
            state.draft.value = '修改后再改回';
            state.draft.value = rawQuestion;
            await state.submit();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(await state.recover()).toBe(id(30));
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
                new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('idempotency-key'),
            );
            expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
        },
    );
    it('keeps draft and stable attempt on actual network failure', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => {
            throw new TypeError('network');
        });
        const { state } = mount(fetcher);
        state.draft.value = rawQuestion;
        await state.submit();
        expect(state.attempt.value?.question).toBe(rawQuestion);
        expect(state.draft.value).toBe(rawQuestion);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('mismatch409 is terminal until explicit end; no automatic new key', async () => {
        const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> =>
            failure(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH'),
        );
        const { state } = mount(fetcher);
        state.draft.value = rawQuestion;
        await state.submit();
        expect(state.terminal.value).toBe(true);
        await state.recover();
        expect(fetcher).toHaveBeenCalledTimes(1);
        state.newQuestion();
        expect(state.attempt.value).toBeUndefined();
        expect(state.terminal.value).toBe(false);
    });
    it('blocks double-submit while pending and preserves same-report new snapshot attempt', async () => {
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => pending.promise);
        const { state, report } = mount(fetcher);
        state.draft.value = rawQuestion;
        const first = state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const original = state.attempt.value;
        report.value = reportFixture();
        await nextTick();
        await state.submit();
        expect(state.attempt.value).toBe(original);
        expect(fetcher).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json(resultFixture(), { status: 201 }));
        await first;
        expect(state.answer.value?.id).toBe(id(30));
    });
    it('does not display semantically invalid POST; keeps original problem unresolved', async () => {
        const result = resultFixture();
        result.answer.statements[0]!.citations[0]!.evidenceId = id(99);
        const { state } = mount(async () => Response.json(result, { status: 201 }));
        state.draft.value = rawQuestion;
        await state.submit();
        expect(state.answer.value).toBeUndefined();
        expect(state.selectedId.value).toBe('');
        expect(state.attempt.value?.question).toBe(rawQuestion);
    });
    it('reads explicit URL ID only after report success and never POSTs on refresh', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json(resultFixture()));
        const { state, report } = mount(fetcher, id(30), null);
        await nextTick();
        expect(fetcher).not.toHaveBeenCalled();
        report.value = reportFixture();
        await vi.waitFor(() => expect(state.answer.value?.id).toBe(id(30)));
        expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([[['invalid']], [[id(30), id(30)]], [null], ['bad']])(
        'does not request malformed query %s',
        async (selection) => {
            const fetcher = vi.fn<typeof fetch>();
            const { state } = mount(fetcher, selection);
            await nextTick();
            expect(state.address.value.error).toBeTruthy();
            expect(fetcher).not.toHaveBeenCalled();
        },
    );
    it('hides cached answers when Report becomes unavailable, retaining copyable local problem', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json(resultFixture(), { status: 201 }),
        );
        const { state, report } = mount(fetcher);
        state.draft.value = rawQuestion;
        await state.submit();
        state.draft.value = rawQuestion;
        report.value = undefined;
        expect(state.answer.value).toBeUndefined();
        expect(state.draft.value).toBe(rawQuestion);
        expect(state.canRecover.value).toBe(false);
        expect(state.canSubmit.value).toBe(false);
    });
    it('cancels POST on unavailable report and preserves unknown attempt through recovery', async () => {
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => pending.promise);
        const { state, report } = mount(fetcher);
        state.draft.value = rawQuestion;
        const request = state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        const key = state.attempt.value?.key;
        report.value = undefined;
        await nextTick();
        await request;
        expect(state.attempt.value?.key).toBe(key);
        expect(state.draft.value).toBe(rawQuestion);
        expect(state.pending.value).toBe(false);
        pending.resolve(Response.json(resultFixture(), { status: 201 }));
        report.value = reportFixture();
        await nextTick();
        expect(state.answer.value).toBeUndefined();
        expect(state.canRecover.value).toBe(true);
    });
    it.each([200, 401])('isolates old owner late%s from replacement account', async (status) => {
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => pending.promise);
        const { state, lifecycle } = mount(fetcher);
        state.draft.value = rawQuestion;
        const request = state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        lifecycle.replaceSession({ ...account, user: { ...account.user, id: id(101) } });
        pending.resolve(
            status === 401 ? failure(401) : Response.json(resultFixture(), { status: 201 }),
        );
        await request;
        expect(state.answer.value).toBeUndefined();
        expect(state.draft.value).toBe('');
        expect(state.attempt.value).toBeUndefined();
        expect(lifecycle.session.user?.id).toBe(id(101));
    });
    it('report replacement clears original action and prevents late result association', async () => {
        const pending = deferred<Response>();
        const fetcher = vi.fn<typeof fetch>(() => pending.promise);
        const { state, reportId, report } = mount(fetcher);
        state.draft.value = rawQuestion;
        const request = state.submit();
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        reportId.value = id(99);
        report.value = { ...reportFixture(), id: id(99) };
        pending.resolve(Response.json(resultFixture(), { status: 201 }));
        await request;
        expect(state.answer.value).toBeUndefined();
        expect(state.draft.value).toBe('');
    });
    it('failed explicit known-ID reread hides previous cache instead of proving recovery', async () => {
        const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> =>
            fetcher.mock.calls.length === 1 ? Response.json(resultFixture()) : failure(503),
        );
        const { state } = mount(fetcher, id(30));
        await vi.waitFor(() => expect(state.answer.value?.id).toBe(id(30)));
        expect(await state.recover()).toBeUndefined();
        expect(state.answer.value).toBeUndefined();
        expect(state.query.isError.value).toBe(true);
    });
});
