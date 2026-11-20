import type { RouteRecordRaw } from 'vue-router';

export default [
    {
        name: 'projects',
        path: '/projects',
        component: () => import('@/view/ProjectsView.vue'),
        meta: { titleKey: 'projects', section: 'projects', navigation: 'primary' },
    },
    {
        name: 'project-detail',
        path: '/projects/:projectId',
        component: () => import('@/view/ProjectDetailView.vue'),
        meta: { titleKey: 'project', section: 'projects' },
    },
] satisfies RouteRecordRaw[];
