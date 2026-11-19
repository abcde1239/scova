import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/reports/:reportId',
        name: 'report-detail',
        component: () => import('@/view/ReportDetailView.vue'),
        meta: { titleKey: 'report', section: 'inbox' },
    },
] satisfies RouteRecordRaw[];
