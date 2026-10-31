import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/tasks/reports',
        name: 'report-history',
        component: () => import('@/views/ReportHistoryView.vue'),
        meta: { title: '报告历史', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
