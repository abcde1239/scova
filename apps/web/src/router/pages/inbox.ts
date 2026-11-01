import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/inbox',
        name: 'inbox',
        component: () => import('@/views/InboxView.vue'),
        meta: { title: '收件箱', section: 'inbox', navigation: 'primary' },
    },
] satisfies RouteRecordRaw[];
