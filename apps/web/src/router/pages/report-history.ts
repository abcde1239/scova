import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/tasks/reports',
        name: 'report-history',
        component: () => import('@/view/ReportHistoryView.vue'),
        meta: { titleKey: 'reportHistory', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
