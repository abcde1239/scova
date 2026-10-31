import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/reports/:reportId',
        name: 'report-detail',
        component: () => import('@/views/ReportDetailView.vue'),
        meta: { title: '报告', section: 'inbox' },
    },
] satisfies RouteRecordRaw[];
