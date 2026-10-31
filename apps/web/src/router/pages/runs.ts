import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/runs/:runId',
        name: 'run-detail',
        component: () => import('@/views/RunDetailView.vue'),
        meta: { title: '执行详情', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
