import type { RouteRecordRaw } from 'vue-router';
export default [
    {
        path: '/library',
        name: 'library',
        component: () => import('@/views/LibraryView.vue'),
        meta: { title: '资料库', section: 'library', navigation: 'primary' },
    },
] satisfies RouteRecordRaw[];
