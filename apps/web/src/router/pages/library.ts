import type { RouteRecordRaw } from 'vue-router';
export default [
    {
        path: '/library/sources/:sourceId/snapshots/:snapshotId?',
        name: 'source-history',
        component: () => import('@/views/SourceHistoryView.vue'),
        meta: { title: '来源历史', section: 'library' },
    },
    {
        path: '/library',
        name: 'library',
        component: () => import('@/views/LibraryView.vue'),
        meta: { title: '资料库', section: 'library', navigation: 'primary' },
    },
] satisfies RouteRecordRaw[];
