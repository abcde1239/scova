<template>
    <project-thread-view
        :key="`${projectId}/${threadId}/${lifecycle.session.epoch}`"
        :project-id="projectId"
        :thread-id="threadId"
    >
        <template #context="panel">
            <project-workbench-report-reader
                v-if="panel.reportId"
                :key="panel.reportId"
                :project-id="panel.projectId"
                :report-id="panel.reportId"
                :wide="panel.readingWide"
                :can-cite="panel.canCite"
                @toggle-width="panel.toggleReadingWidth"
                @close="panel.closeReport"
                @cite="panel.quoteReport"
                @cite-source="panel.citeSource"
            />
            <project-workbench-overview
                v-else-if="panel.detail"
                :detail="panel.detail"
                :items="panel.items"
                @open-report="panel.readReport"
                @focus-item="panel.focusItem"
            >
                <template #settings
                    ><project-settings-panel :project-id="panel.projectId"
                /></template>
            </project-workbench-overview>
            <project-thread-context v-else :project-id="panel.projectId" />
        </template>
    </project-thread-view>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionLifecycle } from '@/composable/useSessionQuery';
import ProjectThreadView from '@/view/ProjectThreadView.vue';
import ProjectSettingsPanel from '@/component/projects/ProjectSettingsPanel.vue';
import ProjectThreadContext from '@/component/projects/ProjectThreadContext.vue';
import ProjectWorkbenchOverview from '@/component/projects/ProjectWorkbenchOverview.vue';
import ProjectWorkbenchReportReader from '@/component/projects/ProjectWorkbenchReportReader.vue';

const route = useRoute();
const lifecycle = useSessionLifecycle();
const projectId = computed(() => String(route.params.projectId ?? ''));
const threadId = computed(() => String(route.params.threadId ?? ''));
</script>
