import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/runs/:runId',
        name: 'run-detail',
        component: () => import('@/view/RunDetailView.vue'),
        meta: { titleKey: 'run', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
