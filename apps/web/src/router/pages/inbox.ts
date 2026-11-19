import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/inbox',
        name: 'inbox',
        component: () => import('@/view/InboxView.vue'),
        meta: { titleKey: 'inbox', section: 'inbox', navigation: 'primary' },
    },
] satisfies RouteRecordRaw[];
