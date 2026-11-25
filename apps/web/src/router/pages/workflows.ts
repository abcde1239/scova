import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        name: 'workflows',
        path: '/workflows',
        component: () => import('@/view/WorkflowsView.vue'),
        meta: { titleKey: 'workflows', section: 'workflows', navigation: 'primary' },
    },
    {
        name: 'workflow-detail',
        path: '/workflows/:workflowId',
        component: () => import('@/view/WorkflowDetailView.vue'),
        meta: { titleKey: 'workflow', section: 'workflows' },
    },
    {
        name: 'workflow-run-detail',
        path: '/workflow-runs/:runId',
        component: () => import('@/view/WorkflowRunDetailView.vue'),
        meta: { titleKey: 'workflow', section: 'workflows' },
    },
] satisfies RouteRecordRaw[];
