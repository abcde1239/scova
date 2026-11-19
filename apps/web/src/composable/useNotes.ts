import {
    computed,
    nextTick,
    onScopeDispose,
    ref,
    shallowRef,
    toValue,
    watch,
    type MaybeRefOrGetter,
} from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { parseRevisionEtag, type LibraryTarget } from '@scova/models';
import type { SessionLifecycle } from '@/api/session';
import {
    createNoteEndpoint,
    deleteNoteEndpoint,
    noteEndpoint,
    notesEndpoint,
    patchNoteEndpoint,
    type Note,
} from '@/api/notes';
import { toApiError } from '@/api/errors';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import {
    createdNoteResponse,
    invalidNote,
    noteAttempt,
    notePage,
    noteReadError,
    noteResponse,
    noteRetryAt,
    noteTargetKey,
    noteTextError,
    unsafeNoteRead,
    type NoteAttempt,
} from '@/utils/notes';

export function useNotes(
    target: MaybeRefOrGetter<LibraryTarget | undefined>,
    active: MaybeRefOrGetter<boolean> = true,
    lifecycle: SessionLifecycle = useSessionLifecycle(),
) {
    const cursor = ref<string>();
    const previous = ref<(string | undefined)[]>([]);
    const query = useQuery(
        computed(() => {
            const current = toValue(target);
            const value = cursor.value;
            const options = lifecycle.queryOptions(
                notesEndpoint,
                {
                    query: {
                        limit: 20,
                        ...(value ? { cursor: value } : {}),
                        ...(current?.kind === 'source' ? { sourceId: current.id } : {}),
                        ...(current?.kind === 'report' ? { reportId: current.id } : {}),
                    },
                },
                ['notes', 'page'],
            );
            return {
                ...options,
                enabled: options.enabled && toValue(active),
                async queryFn(context: { signal: AbortSignal }) {
                    const response = await options.queryFn(context);
                    notePage(response.data, value, current);
                    return response;
                },
            };
        }),
        lifecycle.queryClient,
    );
    watch(
        () =>
            `${lifecycle.session.epoch}:${toValue(target) ? noteTargetKey(toValue(target)!) : 'all'}`,
        () => {
            cursor.value = undefined;
            previous.value = [];
        },
    );
    const items = computed(() =>
        query.isError.value && unsafeNoteRead(query.error.value)
            ? []
            : (query.data.value?.data.items ?? []),
    );
    function next() {
        const nextCursor = query.data.value?.data.nextCursor;
        if (!nextCursor || query.isFetching.value || query.isError.value) return;
        previous.value.push(cursor.value);
        cursor.value = nextCursor;
    }
    function back() {
        if (!query.isFetching.value && previous.value.length) cursor.value = previous.value.pop();
    }
    async function first() {
        const scope = lifecycle.capture();
        const current = toValue(target);
        const targetIdentity = current ? noteTargetKey(current) : 'all';
        previous.value = [];
        cursor.value = undefined;
        await nextTick();
        const latest = toValue(target);
        if (
            !scope.isCurrent() ||
            !toValue(active) ||
            (latest ? noteTargetKey(latest) : 'all') !== targetIdentity
        )
            return;
        // Switching to a fresh cached first page is not a new read; refetch its now-current Query.
        await query.refetch({ cancelRefetch: false });
    }
    return { query, items, previous, next, back, first };
}

/** Local editing state holds user drafts and action bindings; Note rows remain in Vue Query. */
export function useNoteEditor(
    lifecycle: SessionLifecycle = useSessionLifecycle(),
    available: MaybeRefOrGetter<boolean> = true,
) {
    const mode = ref<'closed' | 'create' | 'edit'>('closed');
    const target = shallowRef<LibraryTarget>();
    const selectedId = ref('');
    const draft = ref('');
    const baseBody = ref('');
    const editTag = ref('');
    const pending = ref(false);
    const reading = ref(false);
    const notice = ref('');
    const lock = ref<
        '' | 'read' | 'review' | 'conflict' | 'unknown-patch' | 'unknown-delete' | 'deleted'
    >('');
    const attempt = shallowRef<NoteAttempt>();
    const attemptTerminal = ref(false);
    const reviewReady = ref(false);
    const retryAt = ref<number>();
    const now = ref(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let controller = new AbortController();
    const detailOptions = computed(() =>
        lifecycle.queryOptions(noteEndpoint, { params: { noteId: selectedId.value } }, [
            'notes',
            'detail',
            selectedId.value,
        ]),
    );
    const detail = useQuery(
        computed(() => ({ ...detailOptions.value, enabled: false })),
        lifecycle.queryClient,
    );
    const server = computed(() =>
        detail.isError.value && unsafeNoteRead(detail.error.value)
            ? undefined
            : detail.data.value?.data,
    );
    const dirty = computed(() =>
        mode.value === 'create'
            ? draft.value !== ''
            : mode.value === 'edit' && draft.value !== baseBody.value,
    );
    const waiting = computed(() => retryAt.value !== undefined && now.value < retryAt.value);
    const protectedState = computed(
        () =>
            pending.value ||
            reading.value ||
            dirty.value ||
            !!attempt.value ||
            (!!lock.value && mode.value !== 'closed'),
    );
    const canSave = computed(
        () =>
            toValue(available) &&
            !!lifecycle.session.user &&
            mode.value !== 'closed' &&
            !pending.value &&
            !reading.value &&
            !waiting.value &&
            !attempt.value &&
            !lock.value &&
            !noteTextError(draft.value) &&
            (mode.value === 'create' || !!editTag.value),
    );
    function clear() {
        generation++;
        controller.abort();
        controller = new AbortController();
        if (timer) clearTimeout(timer);
        timer = undefined;
        mode.value = 'closed';
        target.value = undefined;
        selectedId.value = '';
        draft.value = baseBody.value = editTag.value = notice.value = '';
        pending.value = reading.value = reviewReady.value = attemptTerminal.value = false;
        attempt.value = undefined;
        lock.value = '';
        retryAt.value = undefined;
    }
    const stop = watch(() => lifecycle.session.epoch, clear, { flush: 'sync' });
    onScopeDispose(() => {
        stop();
        clear();
    });
    function canLeave(confirm: (message: string) => boolean) {
        if (!lifecycle.session.user) return true;
        if (pending.value || reading.value) {
            notice.value = '请等待当前笔记操作完成。';
            return false;
        }
        if (attempt.value) {
            notice.value = '请先同键核对创建结果，或明确结束本次创建尝试。';
            return false;
        }
        if (lock.value === 'unknown-patch' || lock.value === 'unknown-delete') {
            if (!toValue(available))
                return confirm(
                    '报告暂时不可用，上次笔记操作结果尚未确认。离开会放弃本地稿与待核对状态，请先复制需要保留的内容。是否继续？',
                );
            notice.value = '上次操作结果尚未确认，请先重新读取笔记。';
            return false;
        }
        return !dirty.value || confirm('笔记有未保存的本地稿。离开将放弃本地改动，是否继续？');
    }
    function begin(value: LibraryTarget) {
        if (!toValue(available)) return;
        clear();
        target.value = { kind: value.kind, id: value.id };
        mode.value = 'create';
    }
    async function refreshLists() {
        const scope = lifecycle.capture();
        await lifecycle.queryClient.invalidateQueries({
            predicate: (query) =>
                query.queryKey[0] === 'session' &&
                query.queryKey[1] === scope.accountId &&
                query.queryKey[2] === scope.epoch &&
                query.queryKey[3] === 'notes' &&
                query.queryKey[4] === 'page',
        });
    }
    async function read(initial = false) {
        if (
            !toValue(available) ||
            !selectedId.value ||
            !target.value ||
            pending.value ||
            reading.value
        )
            return;
        const scope = lifecycle.capture();
        const own = generation;
        const expected = { id: selectedId.value, target: target.value };
        const options = detailOptions.value;
        reading.value = true;
        reviewReady.value = false;
        try {
            await lifecycle.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
            // No cache success, cancelled read or background update can prove this explicit GET.
            let networkRead = false;
            const response = await lifecycle.queryClient.fetchQuery({
                ...options,
                staleTime: 0,
                async queryFn(context: { signal: AbortSignal }) {
                    const result = await options.queryFn({
                        signal: AbortSignal.any([context.signal, controller.signal]),
                    });
                    noteResponse(result, expected);
                    networkRead = true;
                    return result;
                },
            });
            if (!scope.isCurrent() || own !== generation || !networkRead) return;
            if (initial) {
                draft.value = baseBody.value = response.data.body;
                editTag.value = response.headers.etag!;
                lock.value = '';
            } else {
                lock.value = 'review';
                reviewReady.value = true;
                notice.value = '已读取服务端当前副本；本地稿保持原样。请明确选择采用或整理后保存。';
            }
        } catch (cause) {
            if (!scope.isCurrent() || own !== generation) return;
            const error = toApiError(cause);
            if (error.status === 404) {
                lock.value = 'deleted';
                notice.value = '笔记不存在或当前账号无法访问；本地稿仍保留，可复制后关闭。';
                await refreshLists();
            } else notice.value = noteReadError(cause);
        } finally {
            if (scope.isCurrent() && own === generation) reading.value = false;
        }
    }
    async function open(note: Note) {
        if (!toValue(available)) return;
        clear();
        selectedId.value = note.id;
        target.value = { ...note.target };
        mode.value = 'edit';
        lock.value = 'read';
        await read(true);
    }
    function adopt(keepLocal: boolean) {
        const response = detail.data.value;
        if (
            !toValue(available) ||
            !reviewReady.value ||
            !server.value ||
            !response ||
            pending.value ||
            reading.value
        )
            return;
        if (!keepLocal) draft.value = server.value.body;
        baseBody.value = server.value.body;
        editTag.value = response.headers.etag!;
        lock.value = '';
        reviewReady.value = false;
        notice.value = keepLocal
            ? '本地稿已保留。下一次保存将以刚读取的服务端版本校验，请先整理。'
            : '已明确采用服务端正文。';
    }
    function waitForRate(cause: unknown) {
        retryAt.value = noteRetryAt(cause);
        now.value = Date.now();
        if (timer) clearTimeout(timer);
        const tick = () => {
            now.value = Date.now();
            if (retryAt.value !== undefined && now.value < retryAt.value)
                timer = setTimeout(tick, Math.min(1000, retryAt.value - now.value));
        };
        if (waiting.value) timer = setTimeout(tick, Math.min(1000, retryAt.value! - now.value));
    }
    function failed(cause: unknown, action: 'create' | 'patch' | 'delete') {
        const error = toApiError(cause);
        if (error.status === 429) {
            waitForRate(cause);
            notice.value =
                retryAt.value === undefined
                    ? '请求过于频繁，请稍后明确重试；本地稿已保留。'
                    : '请求过于频繁，请等待服务端指定时间后重试；本地稿已保留。';
        } else if (action === 'create') {
            attemptTerminal.value = [
                'IDEMPOTENCY_RESOURCE_DELETED',
                'IDEMPOTENCY_PAYLOAD_MISMATCH',
            ].includes(error.code);
            notice.value =
                error.code === 'IDEMPOTENCY_RESOURCE_DELETED'
                    ? '该创建尝试对应的笔记已删除，旧键不能复建。请明确结束本次尝试后再决定新建。'
                    : error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH'
                      ? '创建键与服务端记录不一致；原稿保留，请明确结束本次尝试并核对。'
                      : '创建结果尚未确认；原目标、原稿和幂等键已保留，请同键核对重放。';
        } else if (error.status === 409) {
            lock.value = 'conflict';
            reviewReady.value = false;
            notice.value = '修订冲突：本地稿已保留。重新读取只展示服务端副本，不会自动覆盖。';
        } else if ([400, 403, 404, 422, 428].includes(error.status ?? 0)) {
            notice.value = '操作未完成，本地稿已保留。请核对权限、内容或重新读取版本。';
            lock.value = 'conflict';
            reviewReady.value = false;
        } else {
            lock.value = action === 'patch' ? 'unknown-patch' : 'unknown-delete';
            reviewReady.value = false;
            notice.value = '操作结果尚未确认，本地稿已保留。请先实际重新读取，勿直接重发。';
        }
    }
    async function create(replay = false) {
        if (
            !toValue(available) ||
            pending.value ||
            reading.value ||
            waiting.value ||
            !target.value ||
            attemptTerminal.value
        )
            return;
        if (!replay) {
            if (!canSave.value || mode.value !== 'create') return;
            attempt.value = noteAttempt(target.value, draft.value);
        }
        const command = attempt.value;
        if (!command) return;
        const scope = lifecycle.capture(),
            own = generation;
        pending.value = true;
        try {
            const response = createdNoteResponse(
                await scope.request(
                    createNoteEndpoint,
                    { body: command.input },
                    { signal: controller.signal, idempotencyKey: command.key },
                ),
                command,
            );
            if (!scope.isCurrent() || own !== generation) return;
            attempt.value = undefined;
            selectedId.value = response.data.note.id;
            mode.value = 'edit';
            lock.value = 'read';
            pending.value = false;
            await read(!response.data.reused);
            if (scope.isCurrent() && own === generation) {
                if (!response.data.reused && !lock.value) notice.value = '笔记已创建。';
                await refreshLists();
            }
        } catch (cause) {
            if (scope.isCurrent() && own === generation) failed(cause, 'create');
        } finally {
            if (scope.isCurrent() && own === generation) pending.value = false;
        }
    }
    function endAttempt(confirm: (message: string) => boolean) {
        if (
            !attempt.value ||
            pending.value ||
            !confirm(
                '结束本次创建尝试将不再重放原键。服务端可能已有笔记，另起新建可能产生重复。原稿仍保留，是否继续？',
            )
        )
            return false;
        attempt.value = undefined;
        attemptTerminal.value = false;
        notice.value = '本次创建尝试已明确结束；原稿保留，请先核对已有笔记，再另起新建。';
        return true;
    }
    async function write(deleting = false) {
        if (
            !toValue(available) ||
            mode.value !== 'edit' ||
            !editTag.value ||
            lock.value ||
            pending.value ||
            reading.value ||
            waiting.value ||
            !target.value ||
            (!deleting && !canSave.value)
        )
            return;
        const scope = lifecycle.capture(),
            own = generation;
        const expected = { id: selectedId.value, target: target.value };
        const body = draft.value,
            tag = editTag.value;
        pending.value = true;
        try {
            if (deleting) {
                const result = await scope.request(
                    deleteNoteEndpoint,
                    { params: { noteId: expected.id } },
                    { signal: controller.signal, ifMatch: tag },
                );
                if (result.status !== 204) invalidNote('删除笔记响应状态无效');
                if (!scope.isCurrent() || own !== generation) return;
                lock.value = 'deleted';
                baseBody.value = draft.value;
                lifecycle.queryClient.removeQueries({
                    queryKey: detailOptions.value.queryKey,
                    exact: true,
                });
                notice.value = '笔记已删除；来源、收藏和报告保持不变。';
            } else {
                const result = noteResponse(
                    await scope.request(
                        patchNoteEndpoint,
                        { params: { noteId: expected.id }, body: { body } },
                        { signal: controller.signal, ifMatch: tag },
                    ),
                    expected,
                );
                if (
                    result.data.body !== body ||
                    result.data.revision !== parseRevisionEtag(tag) + 1
                )
                    invalidNote('保存返回的笔记正文或递增修订不一致');
                if (!scope.isCurrent() || own !== generation) return;
                await lifecycle.queryClient.cancelQueries({
                    queryKey: detailOptions.value.queryKey,
                    exact: true,
                });
                if (!scope.isCurrent() || own !== generation) return;
                lifecycle.queryClient.setQueryData(detailOptions.value.queryKey, result);
                baseBody.value = body;
                editTag.value = result.headers.etag!;
                notice.value = '笔记已保存。';
            }
            await refreshLists();
        } catch (cause) {
            if (scope.isCurrent() && own === generation)
                failed(cause, deleting ? 'delete' : 'patch');
        } finally {
            if (scope.isCurrent() && own === generation) pending.value = false;
        }
    }
    return {
        mode,
        target,
        selectedId,
        draft,
        pending,
        reading,
        notice,
        lock,
        attempt,
        attemptTerminal,
        server,
        detail,
        dirty,
        protectedState,
        canSave,
        reviewReady,
        retryAt,
        waiting,
        clear,
        canLeave,
        begin,
        open,
        read,
        adopt,
        create,
        endAttempt,
        write,
    };
}
