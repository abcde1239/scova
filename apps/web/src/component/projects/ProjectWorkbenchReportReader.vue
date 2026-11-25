<template>
    <section class="workbench-reader" :aria-labelledby="titleId">
        <header class="reader-toolbar">
            <h2 :id="titleId" ref="title" class="m-0 text-sm font-semibold" tabindex="-1">
                侧栏阅读
            </h2>
            <div class="reader-actions">
                <button
                    v-if="wide !== undefined"
                    type="button"
                    class="internal-link"
                    :aria-pressed="wide"
                    @click="emit('toggle-width')"
                >
                    加宽
                </button>
                <router-link v-if="visibleReport" class="internal-link" :to="fullReport">
                    打开全文
                </router-link>
                <button type="button" class="internal-link" @click="emit('close')">关闭阅读</button>
            </div>
        </header>
        <div class="reader-content">
            <p v-if="loadState === 'loading'" class="m-0 text-muted" role="status">正在读取报告…</p>
            <div v-else-if="loadState !== 'ready'" class="reader-error">
                <p class="m-0" role="alert">{{ failure.message }}</p>
                <button v-if="failure.retryable" type="button" class="internal-link" @click="retry">
                    重试
                </button>
            </div>
            <article v-else-if="visibleReport" class="reader-article">
                <h3 class="m-0">{{ visibleReport.title }}</h3>
                <p class="reader-meta m-0">
                    <time :datetime="visibleReport.publishedAt">{{
                        localTaskTime(visibleReport.publishedAt)
                    }}</time>
                    <span>{{ visibleReport.evidence.length }} 条证据</span>
                </p>
                <section v-for="section in sections" :key="section.key" class="reader-section">
                    <h4 class="m-0">{{ section.title }}</h4>
                    <div
                        v-for="(paragraph, index) in section.paragraphs"
                        :key="index"
                        class="reader-paragraph"
                    >
                        <p v-if="paragraph.label" class="reader-meta m-0">{{ paragraph.label }}</p>
                        <p class="reader-prose m-0">{{ paragraph.reference.text }}</p>
                        <button
                            type="button"
                            v-if="canCite"
                            class="internal-link reader-cite"
                            @pointerdown="preserveSelection"
                            @click="citeParagraph($event, paragraph.reference)"
                        >
                            引用到对话<span class="sr-only"
                                >：{{ section.title }} 第 {{ index + 1 }} 段</span
                            >
                        </button>
                    </div>
                </section>
                <details class="reader-section" @toggle="toggleSources">
                    <summary class="cursor-pointer font-semibold">报告来源</summary>
                    <p
                        v-if="sourceQuery.isPending.value || sourceQuery.isFetching.value"
                        class="m-0 text-muted"
                        role="status"
                    >
                        正在读取报告来源…
                    </p>
                    <div v-else-if="!sourceData" class="reader-error">
                        <p class="m-0" role="alert">报告来源暂不可用。</p>
                        <button
                            v-if="sourceRetryable"
                            type="button"
                            class="internal-link"
                            @click="sourceQuery.refetch()"
                        >
                            重试读取来源
                        </button>
                    </div>
                    <p v-else-if="!sourceData.sources.length" class="m-0 text-muted">
                        这份报告没有可引用的来源。
                    </p>
                    <ul v-else class="grid gap-2 m-0 p-0 list-none">
                        <li
                            v-for="source in sourceData.sources"
                            :key="source.snapshotId"
                            class="grid gap-1"
                        >
                            <span>{{ source.title }}</span>
                            <button
                                v-if="canCite"
                                type="button"
                                class="internal-link reader-cite"
                                @click="citeSource(source)"
                            >
                                引用此来源<span class="sr-only">：{{ source.title }}</span>
                            </button>
                        </li>
                    </ul>
                </details>
            </article>
        </div>
    </section>
</template>

<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ProjectReportEvidence } from '@scova/models';
import { toApiError } from '@/api/errors';
import { projectReportEvidenceEndpoint } from '@/api/project-evidence';
import { taskProjectEndpoint } from '@/api/projects';
import { useReport } from '@/composable/useReport';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { localTaskTime } from '@/composable/useTasks';
import {
    projectReportSections,
    type ProjectReportCitation,
    type ProjectReportSourceCitation,
} from '@/utils/project-report-reader';

const props = withDefaults(
    defineProps<{ projectId: string; reportId: string; wide?: boolean; canCite?: boolean }>(),
    {
        wide: undefined,
        canCite: true,
    },
);
const emit = defineEmits<{
    close: [];
    'toggle-width': [];
    cite: [reference: ProjectReportCitation];
    'cite-source': [reference: ProjectReportSourceCitation];
}>();
const titleId = useId();
const title = useTemplateRef<HTMLHeadingElement>('title');
const lifecycle = useSessionLifecycle();
const { query, report, valid, error } = useReport(() => props.reportId, lifecycle);
const membership = useQuery(
    computed(() => {
        const taskId = report.value?.taskId;
        const options = lifecycle.queryOptions(
            taskProjectEndpoint,
            { params: { taskId: taskId ?? '' } },
            ['task-project', taskId],
        );
        return { ...options, enabled: options.enabled && !!taskId, staleTime: 0 };
    }),
    lifecycle.queryClient,
);
const visibleReport = computed(() =>
    membership.isSuccess.value &&
    !membership.isFetching.value &&
    membership.data.value?.data.project?.id === props.projectId
        ? report.value
        : undefined,
);
const sourcesOpen = ref(false);
const sourceQuery = useQuery(
    computed(() => {
        const options = lifecycle.queryOptions(projectReportEvidenceEndpoint, {
            params: { projectId: props.projectId, reportId: props.reportId },
        });
        return {
            ...options,
            enabled: options.enabled && sourcesOpen.value && !!visibleReport.value,
            staleTime: 0,
            retry: false,
        };
    }),
    lifecycle.queryClient,
);
const sourceData = computed(() => {
    const data = sourceQuery.data.value?.data;
    if (!sourceQuery.isError.value && data?.id === props.reportId) return data;
});
const sourceRetryable = computed(
    () => ![401, 403, 404].includes(toApiError(sourceQuery.error.value).status ?? 0),
);
function toggleSources(event: Event) {
    sourcesOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}
function citeSource(source: ProjectReportEvidence['sources'][number]) {
    emit('cite-source', {
        reportId: props.reportId,
        snapshotId: source.snapshotId,
        title: source.title,
    });
}
const fullReport = computed(() => ({
    name: 'report-detail',
    params: { reportId: props.reportId },
}));
const sections = computed(() =>
    visibleReport.value ? projectReportSections(visibleReport.value) : [],
);
const loadState = computed(() => {
    if (!valid.value || query.isError.value || membership.isError.value) return 'error';
    if (!report.value || membership.isPending.value || membership.isFetching.value)
        return 'loading';
    return visibleReport.value ? 'ready' : 'error';
});
const failure = computed(() => {
    if (!valid.value || query.isError.value) return error.value;
    if (
        membership.isError.value &&
        ![401, 403, 404].includes(toApiError(membership.error.value).status ?? 0)
    )
        return { message: '暂时无法确认报告归属，请重试。', retryable: true };
    return { message: '这份报告已移出项目或当前账号无法访问。', retryable: false };
});

watch(
    () => props.reportId,
    async () => {
        await nextTick();
        title.value?.focus({ preventScroll: true });
    },
    { immediate: true },
);

function selectedQuote(event: Event) {
    const paragraph = (event.currentTarget as HTMLButtonElement).previousElementSibling;
    const selection = window.getSelection();
    if (
        !selection?.anchorNode ||
        !selection.focusNode ||
        !paragraph?.contains(selection.anchorNode) ||
        !paragraph.contains(selection.focusNode)
    )
        return '';
    return selection.toString().trim();
}

function preserveSelection(event: PointerEvent) {
    if (event.button === 0 && selectedQuote(event)) event.preventDefault();
}

function citeParagraph(event: MouseEvent, reference: ProjectReportCitation) {
    const text = selectedQuote(event);
    emit('cite', text ? { ...reference, text } : reference);
}
async function retry() {
    title.value?.focus({ preventScroll: true });
    if (query.isError.value) await query.refetch();
    else await membership.refetch();
}
</script>

<style scoped>
.workbench-reader {
    min-inline-size: 0;
    overflow-wrap: anywhere;
}
.reader-toolbar,
.reader-actions,
.reader-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem 0.85rem;
}
.reader-toolbar {
    justify-content: space-between;
    border-block-end: 1px solid var(--scova-border);
    padding: 0.45rem 1rem;
}
.workbench-reader button {
    appearance: none;
    border: 0;
    padding: 0;
    background: transparent;
    font-family: inherit;
    cursor: pointer;
}
.reader-toolbar .internal-link {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
}
.reader-content {
    padding: clamp(1rem, 4%, 1.75rem);
}
.reader-article,
.reader-section,
.reader-paragraph,
.reader-error {
    display: grid;
    gap: 0.65rem;
    min-inline-size: 0;
}
.reader-article {
    gap: 1rem;
}
.reader-article h3 {
    font: 600 1.45rem/1.4 var(--scova-font-reading);
}
.reader-section + .reader-section {
    padding-block-start: 1rem;
    border-block-start: 1px solid var(--scova-border);
}
.reader-meta {
    color: var(--scova-muted);
    font-size: 0.8125rem;
}
.reader-prose {
    font: 1rem/1.75 var(--scova-font-reading);
    white-space: pre-wrap;
}
.reader-paragraph {
    gap: 0.15rem;
}
.reader-cite,
.reader-error button {
    justify-self: start;
    min-block-size: 1.75rem;
    font-size: 0.8125rem;
    text-align: start;
}
.workbench-reader :is(h2, button, a):focus-visible {
    outline: 2px solid var(--scova-primary);
    outline-offset: 3px;
}
</style>
