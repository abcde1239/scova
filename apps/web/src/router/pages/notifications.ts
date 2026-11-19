import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/notifications',
        name: 'notifications',
        component: () => import('@/view/NotificationsView.vue'),
        meta: { titleKey: 'notifications', section: 'notifications', navigation: 'tool' },
    },
] satisfies RouteRecordRaw[];
