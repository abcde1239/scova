import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/notifications',
        name: 'notifications',
        component: () => import('@/views/NotificationsView.vue'),
        meta: { title: '通知', section: 'notifications', navigation: 'tool' },
    },
] satisfies RouteRecordRaw[];
