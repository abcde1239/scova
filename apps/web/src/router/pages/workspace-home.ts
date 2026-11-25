import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        path: '/',
        name: 'workspace-home',
        component: () => import('@/view/WorkspaceHomeView.vue'),
        meta: { title: '工作台', section: 'projects' },
    },
] satisfies RouteRecordRaw[];
