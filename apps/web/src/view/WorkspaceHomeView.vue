<template>
    <div class="workspace-home layout-grid gap-8">
        <section aria-labelledby="workspace-home-heading" class="layout-grid gap-4">
            <h2 id="workspace-home-heading" class="m-0">今天想研究什么？</h2>
            <form
                class="intake-form layout-grid gap-4 border-theme bg-surface rounded-2 p-4"
                @submit.prevent="submit"
            >
                <label for="workspace-message" class="sr-only">研究需求</label>
                <textarea
                    id="workspace-message"
                    ref="messageInput"
                    v-model="message"
                    :disabled="busy || !!receipt"
                    class="intake-field keyboard-focus-wide bg-surface text-default rounded-2 p-3 border-theme"
                    name="message"
                    rows="3"
                    :maxlength="WorkspaceIntakeInputSchema.properties.message.maxLength"
                    placeholder="描述主题、时间范围或想追踪的变化"
                    required
                />
                <p
                    v-if="needsChoice"
                    id="workspace-project-hint"
                    role="status"
                    class="m-0 text-muted"
                >
                    {{
                        projects.length || candidates.length
                            ? '请选择已有项目，或新建一个项目。'
                            : '没有找到可匹配的项目。你可以新建项目并继续。'
                    }}
                </p>
                <div class="intake-toolbar">
                    <div class="intake-destination">
                        <label for="workspace-destination">归入项目</label>
                        <select
                            id="workspace-destination"
                            ref="destinationInput"
                            v-model="selection"
                            :disabled="busy || !!receipt"
                            :aria-describedby="needsChoice ? 'workspace-project-hint' : undefined"
                            class="intake-field keyboard-focus-wide bg-surface text-default rounded-2 px-3 min-h-11 border-theme"
                        >
                            <option value="auto" :disabled="needsChoice">自动归类</option>
                            <optgroup v-if="candidates.length" label="建议项目">
                                <option
                                    v-for="option in candidates"
                                    :key="option.id"
                                    :value="option.id"
                                >
                                    {{ option.name }}
                                </option>
                            </optgroup>
                            <optgroup v-if="otherProjects.length" label="已有项目">
                                <option
                                    v-for="option in otherProjects"
                                    :key="option.id"
                                    :value="option.id"
                                >
                                    {{ option.name }}
                                </option>
                            </optgroup>
                            <option value="new-project">新建项目</option>
                        </select>
                        <action-button
                            v-if="projectQuery.isError.value && !projects.length"
                            :busy="projectQuery.isFetching.value"
                            :disabled="busy || !!receipt"
                            @click="projectQuery.refetch()"
                            >重试读取项目</action-button
                        >
                        <action-button
                            v-if="projectQuery.hasNextPage.value"
                            :busy="projectQuery.isFetchingNextPage.value"
                            :disabled="busy || !!receipt"
                            @click="projectQuery.fetchNextPage()"
                            >{{
                                projectQuery.isFetchNextPageError.value
                                    ? '重试加载项目'
                                    : '加载更多项目'
                            }}</action-button
                        >
                    </div>
                    <div v-if="selection === 'new-project'" class="intake-destination">
                        <label for="workspace-project-name">新项目名称</label>
                        <input
                            id="workspace-project-name"
                            v-model="projectName"
                            :disabled="busy || !!receipt"
                            class="intake-field keyboard-focus-wide bg-surface text-default rounded-2 px-3 min-h-11 border-theme"
                            required
                            maxlength="120"
                        />
                    </div>
                    <action-button
                        type="primary"
                        attr-type="submit"
                        :busy="busy"
                        :disabled="!canSubmit"
                        >{{ busy ? '正在提交' : receipt ? '重试发送' : '发送' }}</action-button
                    >
                </div>
                <div v-if="errorMessage" role="alert" class="intake-feedback">
                    <p class="m-0">{{ errorMessage }}</p>
                    <router-link v-if="receipt" class="internal-link" :to="threadLocation(receipt)"
                        >打开已创建的会话</router-link
                    >
                </div>
            </form>
            <router-link class="internal-link justify-self-start" to="/tasks/new"
                >创建独立任务</router-link
            >
        </section>

        <state-panel v-if="home.isPending.value" state="loading" message="正在读取工作台" />
        <state-panel
            v-else-if="home.isError.value && !home.data.value"
            state="error"
            :message="toApiError(home.error.value).message"
            retryable
            @retry="home.refetch()"
        />
        <template v-else>
            <section aria-labelledby="workspace-pending-heading" class="layout-grid gap-3">
                <h2 id="workspace-pending-heading" class="m-0">待处理</h2>
                <ul v-if="pending.length" class="layout-grid gap-2 list-none p-0 m-0">
                    <li
                        v-for="plan in pending"
                        :key="plan.id"
                        class="pending-plan border-theme bg-surface rounded-2 p-4"
                    >
                        <div class="break-anywhere">
                            <strong>{{ plan.projectName }}</strong>
                            <p class="m-0 text-muted">{{ plan.threadTitle }} · 研究计划待确认</p>
                        </div>
                        <router-link
                            class="internal-link"
                            :to="threadLocation(plan)"
                            :aria-label="`打开会话：${plan.threadTitle}`"
                            >打开会话</router-link
                        >
                    </li>
                </ul>
                <p v-else class="m-0 text-muted">暂无待确认的研究计划。</p>
            </section>
            <section aria-labelledby="workspace-recent-heading" class="layout-grid gap-3">
                <h2 id="workspace-recent-heading" class="m-0">最近项目</h2>
                <ul v-if="recentProjects.length" class="recent-projects list-none p-0 m-0">
                    <li v-for="project in recentProjects" :key="project.id" class="min-w-0">
                        <router-link
                            class="recent-project-card layout-grid gap-1 border-theme bg-surface rounded-2 p-4 keyboard-focus-wide break-anywhere"
                            :to="{ name: 'project-detail', params: { projectId: project.id } }"
                        >
                            <strong>{{ project.name }}</strong>
                            <time :datetime="project.lastActivityAt" class="text-muted">{{
                                formatDate(project.lastActivityAt)
                            }}</time>
                        </router-link>
                    </li>
                </ul>
                <div v-else class="border-theme bg-surface rounded-2 p-4 layout-grid gap-2">
                    <p class="m-0">还没有项目。新建项目后，可以在对话里继续研究。</p>
                    <action-button
                        class="justify-self-start"
                        :disabled="busy || !!receipt"
                        @click="chooseNewProject"
                        >新建项目并开始对话</action-button
                    >
                </div>
            </section>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
    parseContract,
    UuidSchema,
    WorkspaceIntakeInputSchema,
    type WorkspaceIntakeInput,
    type WorkspaceIntakeResult,
} from '@scova/models';
import { workspaceHomeEndpoint, workspaceIntakeEndpoint } from '@/api/workspace-intake';
import { sendThreadTurnEndpoint } from '@/api/project-threads';
import { toApiError } from '@/api/errors';
import { shouldReportQueryError } from '@/api/query';
import ActionButton from '@/component/common/ActionButton.vue';
import StatePanel from '@/component/common/StatePanel.vue';
import { invalidateProjects, useProjects } from '@/composable/useProjects';
import {
    useSessionLifecycle,
    useSessionMutation,
    useSessionQuery,
} from '@/composable/useSessionQuery';

type Ready = Extract<WorkspaceIntakeResult, { kind: 'ready' }>;
type Candidate = Extract<WorkspaceIntakeResult, { kind: 'choose-project' }>['candidates'][number];
const lifecycle = useSessionLifecycle();
const router = useRouter();
const { locale } = useI18n();
const home = useSessionQuery(workspaceHomeEndpoint, {}, ['workspace-home'], lifecycle);
const { query: projectQuery, items: projects } = useProjects(lifecycle);
const prepare = useSessionMutation(workspaceIntakeEndpoint, lifecycle);
const send = useSessionMutation(sendThreadTurnEndpoint, lifecycle);
const pending = computed(() => home.data.value?.data.pending ?? []);
const recentProjects = computed(() => home.data.value?.data.recentProjects ?? []);
const messageInput = ref<HTMLTextAreaElement>();
const destinationInput = ref<HTMLSelectElement>();
const message = ref('');
const selection = ref('auto');
const projectName = ref('');
const candidates = ref<Candidate[]>([]);
const needsChoice = ref(false);
const busy = ref(false);
const errorMessage = ref('');
const receipt = ref<Ready>();
const otherProjects = computed(() => {
    const suggested = new Set(candidates.value.map(({ id }) => id));
    const available = new Map(
        [...recentProjects.value, ...projects.value].map((project) => [project.id, project]),
    );
    return [...available.values()].filter(({ id }) => !suggested.has(id));
});
const canSubmit = computed(
    () =>
        !!message.value.trim() &&
        (!needsChoice.value || selection.value !== 'auto') &&
        (selection.value !== 'new-project' || !!projectName.value.trim()),
);
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }));
const formatDate = (date: string) => dateFormat.value.format(new Date(date));
const threadLocation = ({ projectId, threadId }: { projectId: string; threadId: string }) => ({
    name: 'project-thread',
    params: { projectId, threadId },
});
type Attempt = { key: string; body: WorkspaceIntakeInput; expiresAt: number };
const recoveryMs = 60 * 60 * 1000;
const recoveryKey = (userId: string) => `scova:workspace-intake:${userId}`;
let attempt: Attempt | undefined;

function storeAttempt(userId: string, value: Attempt) {
    try {
        window.localStorage.setItem(recoveryKey(userId), JSON.stringify(value));
    } catch {
        // The in-memory retry remains available when browser storage is disabled.
    }
}

function readAttempt(userId: string): Attempt | undefined {
    try {
        const stored = window.localStorage.getItem(recoveryKey(userId));
        if (!stored) return;
        const raw = JSON.parse(stored) as Partial<Attempt> | null;
        if (!raw || typeof raw.expiresAt !== 'number' || raw.expiresAt <= Date.now()) {
            window.localStorage.removeItem(recoveryKey(userId));
            return;
        }
        return {
            key: parseContract(UuidSchema, raw.key),
            body: parseContract(WorkspaceIntakeInputSchema, raw.body),
            expiresAt: raw.expiresAt,
        };
    } catch {
        // Inaccessible or invalid local data must not prevent a new submission.
    }
}

function clearAttempt(userId: string, key: string) {
    try {
        if (readAttempt(userId)?.key === key) window.localStorage.removeItem(recoveryKey(userId));
    } catch {
        // A completed server request does not depend on local storage cleanup.
    }
}
let current = true;
let dispatched = false;
onScopeDispose(() => {
    current = false;
});

watch(
    () => lifecycle.session.epoch,
    () => {
        attempt = undefined;
        dispatched = false;
        receipt.value = undefined;
        busy.value = false;
        message.value = '';
        projectName.value = '';
        selection.value = 'auto';
        candidates.value = [];
        needsChoice.value = false;
        errorMessage.value = '';
    },
);

watch(message, () => {
    if (!needsChoice.value) return;
    candidates.value = [];
    needsChoice.value = false;
});

function chooseNewProject() {
    selection.value = 'new-project';
    messageInput.value?.focus();
}

function destination(): WorkspaceIntakeInput['destination'] {
    if (selection.value === 'auto') return { kind: 'auto' };
    if (selection.value === 'new-project')
        return { kind: 'new-project', name: projectName.value.trim() };
    return { kind: 'project', projectId: selection.value };
}

async function submit() {
    if (!canSubmit.value || busy.value) return;
    const scope = lifecycle.capture();
    const active = () => current && scope.isCurrent();
    const body = { message: message.value.trim(), destination: destination() };
    const userId = lifecycle.session.user?.id;
    if (!userId) return;
    const signature = JSON.stringify(body);
    if (!attempt || JSON.stringify(attempt.body) !== signature || attempt.expiresAt <= Date.now())
        attempt = { body, key: crypto.randomUUID(), expiresAt: Date.now() + recoveryMs };
    const idempotencyKey = attempt.key;
    storeAttempt(userId, attempt);
    busy.value = true;
    errorMessage.value = '';
    try {
        if (!receipt.value) {
            const { data } = await prepare.mutateAsync({
                input: { body },
                options: { idempotencyKey },
            });
            if (!active()) return;
            if (data.kind === 'choose-project') {
                clearAttempt(userId, idempotencyKey);
                candidates.value = data.candidates;
                needsChoice.value = true;
                return;
            }
            receipt.value = data;
            void invalidateProjects(lifecycle, scope);
        }
        const ready = receipt.value;
        if (!dispatched) {
            await send.mutateAsync({
                input: {
                    params: { threadId: ready.threadId },
                    body: { turnId: ready.turnId, message: body.message },
                },
                options: { timeout: 45_000 },
            });
            if (!active()) return;
            dispatched = true;
            clearAttempt(userId, idempotencyKey);
        }
        void home.refetch();
        const failure = await router.push(threadLocation(ready));
        if (failure && active()) errorMessage.value = '会话已经创建，点击下方链接继续。';
    } catch (error) {
        if (active() && shouldReportQueryError(error))
            errorMessage.value = toApiError(error).message;
    } finally {
        if (active()) {
            busy.value = false;
            if (needsChoice.value && selection.value === 'auto') {
                await nextTick();
                destinationInput.value?.focus();
            }
        }
    }
}

watch(
    () => lifecycle.session.user?.id,
    (userId) => {
        if (!userId || busy.value) return;
        const recovered = readAttempt(userId);
        if (!recovered) return;
        attempt = recovered;
        message.value = recovered.body.message;
        const target = recovered.body.destination;
        selection.value = target.kind === 'project' ? target.projectId : target.kind;
        if (target.kind === 'new-project') projectName.value = target.name;
        void submit();
    },
    { immediate: true, flush: 'post' },
);
</script>

<style scoped>
.workspace-home {
    inline-size: 100%;
    max-inline-size: 52rem;
    margin-inline: auto;
}

#workspace-home-heading {
    font-size: clamp(1.5rem, 1.3rem + 1vw, 2.25rem);
}

.intake-form,
.intake-destination,
.intake-field {
    min-inline-size: 0;
}

.intake-toolbar,
.pending-plan {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: 0.75rem;
}

.intake-destination {
    display: grid;
    flex: 1 1 14rem;
    gap: 0.25rem;
}

.intake-field {
    box-sizing: border-box;
    inline-size: 100%;
    font: inherit;
}

textarea.intake-field {
    resize: vertical;
}

.intake-feedback,
.recent-projects {
    display: grid;
    gap: 0.75rem;
}

.recent-projects {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
}

.recent-project-card {
    height: 100%;
    color: inherit;
    text-decoration: none;
}

.recent-project-card:hover strong {
    text-decoration: underline;
}
</style>
