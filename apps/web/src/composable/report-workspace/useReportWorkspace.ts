import { computed, ref, toRaw, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { Report, ReportConversation } from '@scova/models';
import ReportMergeAction from '@/component/reports/ReportMergeAction.vue';
import { useReport } from '@/composable/useReport';
import { reportEndpoint } from '@/api/reports';
import { inboxReturn } from '@/composable/useInbox';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import { useReportReading } from '@/composable/report-workspace/useReportReading';

export function useReportWorkspace(
    detail: import('vue').Ref<HTMLElement | undefined>,
    artifactCard: import('vue').Ref<HTMLButtonElement | undefined>,
) {
    const route = useRoute();
    const lifecycle = useSessionLifecycle();
    const accountId = computed(() => lifecycle.session.user?.id);
    const returnTo = computed(() => {
        void route.fullPath;
        return inboxReturn(window.history.state?.inboxReturn, accountId.value);
    });
    const {
        query,
        report: queryReport,
        valid,
        error,
    } = useReport(() => route.params.reportId, lifecycle);
    const report = computed(() => {
        const value = queryReport.value;
        const reportId = route.params.reportId;
        if (!value || !valid.value || value.id !== reportId) return undefined;
        const current = lifecycle.queryClient.getQueryData(
            lifecycle.queryOptions(reportEndpoint, { params: { reportId } }, ['reports', reportId])
                .queryKey,
        );
        // Vue Query updates its observer in a pre-flush watcher. A synchronous identity change
        // must not initialize a new reading selection or editor from the old observer's result.
        return toRaw(current) === toRaw(query.data.value) ? value : undefined;
    });
    type ConversationArtifact = NonNullable<ReportConversation['artifacts']>[number];
    const conversationArtifacts = ref<ConversationArtifact[]>([]);
    const mergeRuns = ref<NonNullable<ReportConversation['mergeRuns']>>([]);
    const mergeProtected = ref(false);
    const mergeActive = ref(false);
    const mergeAction = ref<InstanceType<typeof ReportMergeAction>>();
    const selectedArtifactId = ref('');
    const selectedArtifact = computed(() =>
        conversationArtifacts.value.find((item) => item.reportId === selectedArtifactId.value),
    );
    const followupReport = useReport(() => selectedArtifact.value?.reportId, lifecycle);
    const readingReport = computed(() => {
        if (!report.value) return undefined;
        if (!selectedArtifactId.value || selectedArtifactId.value === report.value.id)
            return report.value;
        const artifact = selectedArtifact.value;
        const value = followupReport.report.value;
        if (
            !artifact ||
            !value ||
            value.id !== artifact.reportId ||
            value.runId !== artifact.runId ||
            value.taskId !== report.value.taskId ||
            value.taskVersionId !== report.value.taskVersionId ||
            value.mode !== report.value.mode ||
            value.conversation?.reportId !== report.value.id ||
            value.conversation.questionId !== artifact.questionId ||
            value.conversation.operation !== artifact.operation
        )
            return undefined;
        return value;
    });
    const readingQuery = computed(() =>
        selectedArtifactId.value && selectedArtifactId.value !== report.value?.id
            ? followupReport.query
            : query,
    );
    const readingError = computed(() => {
        if (selectedArtifactId.value && selectedArtifactId.value !== report.value?.id) {
            if (followupReport.report.value && !readingReport.value)
                return { message: '成果与当前对话的关联不一致，暂时无法展示。', retryable: true };
            return followupReport.error.value;
        }
        return error.value;
    });
    async function selectArtifact(id: string) {
        if (
            !report.value ||
            (id !== report.value.id &&
                !conversationArtifacts.value.some((item) => item.reportId === id))
        )
            return;
        if (id !== (selectedArtifactId.value || report.value.id)) selectedFormat.value = undefined;
        selectedArtifactId.value = id;
        await openArtifact();
    }
    function openConversationArtifact(artifact: ConversationArtifact) {
        if (!report.value) return;
        if (!conversationArtifacts.value.some((item) => item.reportId === artifact.reportId))
            conversationArtifacts.value = [...conversationArtifacts.value, artifact];
        void selectArtifact(artifact.reportId);
    }
    function rememberArtifact(artifact: ConversationArtifact) {
        conversationArtifacts.value = [
            ...conversationArtifacts.value.filter((item) => item.reportId !== artifact.reportId),
            artifact,
        ];
    }
    function updateArtifacts(artifacts: ConversationArtifact[]) {
        if (!report.value) return;
        conversationArtifacts.value = [
            ...new Map(
                [...conversationArtifacts.value, ...artifacts].map((item) => [item.reportId, item]),
            ).values(),
        ];
    }
    function updateMergeRuns(runs: NonNullable<ReportConversation['mergeRuns']>) {
        if (report.value) mergeRuns.value = runs;
    }
    // Keep only the editor identity, never a second Report cache, across same-owner read failures.
    const questionIdentity = ref('');
    const routeIdentity = computed(
        () =>
            `${lifecycle.session.epoch}:${accountId.value ?? ''}:${String(route.params.reportId)}`,
    );
    const selectedFormat = ref<Report['format']>();
    const {
        readingOnly,
        artifactOpen,
        openArtifact,
        closeArtifact,
        openReading,
        openConversation,
        retry,
        cancelReadingAnimation,
    } = useReportReading(routeIdentity, report, readingQuery, detail, artifactCard);
    const formatLabels = {
        brief: '简报',
        list: '主题清单',
        comparison: '对比表',
        research_report: '研究报告',
    };
    let formatIdentity = '';
    watch(
        [routeIdentity, readingReport],
        ([identity, value]) => {
            if (formatIdentity !== identity) {
                formatIdentity = identity;
                selectedFormat.value = undefined;
            }
            if (value && selectedFormat.value === undefined) selectedFormat.value = value.format;
        },
        { immediate: true, flush: 'sync' },
    );
    watch(
        routeIdentity,
        () => {
            cancelReadingAnimation();
            questionIdentity.value = '';
            conversationArtifacts.value = [];
            mergeRuns.value = [];
            mergeProtected.value = false;
            mergeActive.value = false;
            selectedArtifactId.value = '';
            readingOnly.value = false;
            artifactOpen.value = true;
        },
        { flush: 'sync' },
    );
    watch(
        report,
        (value) => {
            if (value) questionIdentity.value = routeIdentity.value;
        },
        { immediate: true, flush: 'sync' },
    );

    return {
        route,
        accountId,
        returnTo,
        report,
        valid,
        readingQuery,
        readingError,
        readingReport,
        conversationArtifacts,
        mergeRuns,
        mergeProtected,
        mergeActive,
        mergeAction,
        selectedArtifactId,
        selectedArtifact,
        selectArtifact,
        openConversationArtifact,
        rememberArtifact,
        updateArtifacts,
        updateMergeRuns,
        questionIdentity,
        routeIdentity,
        selectedFormat,
        formatLabels,
        detail,
        readingOnly,
        artifactOpen,
        artifactCard,
        openArtifact,
        closeArtifact,
        openReading,
        openConversation,
        retry,
    };
}
