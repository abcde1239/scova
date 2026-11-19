import type { RouteRecordRaw } from 'vue-router';
export default [
    {
        path: '/library/search',
        name: 'library-search',
        component: () => import('@/view/LibrarySearchView.vue'),
        meta: { titleKey: 'librarySearch', section: 'library' },
    },
    {
        path: '/library/sources/:sourceId/snapshots/:snapshotId?',
        name: 'source-history',
        component: () => import('@/view/SourceHistoryView.vue'),
        meta: { titleKey: 'sourceHistory', section: 'library' },
    },
    {
        path: '/library',
        name: 'library',
        component: () => import('@/view/LibraryView.vue'),
        meta: { titleKey: 'library', section: 'library', navigation: 'primary' },
    },
] satisfies RouteRecordRaw[];
