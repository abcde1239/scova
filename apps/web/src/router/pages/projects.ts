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
        component: () => import('@/view/ProjectEntryView.vue'),
        meta: { titleKey: 'project', section: 'projects' },
    },
    {
        name: 'project-thread',
        path: '/projects/:projectId/threads/:threadId',
        component: () => import('@/view/ProjectThreadRoute.vue'),
        meta: { titleKey: 'project', section: 'projects' },
    },
    {
        name: 'project-legacy',
        path: '/projects/:projectId/legacy',
        component: () => import('@/view/ProjectDetailView.vue'),
        meta: { titleKey: 'project', section: 'projects' },
    },
    {
        name: 'project-task-create',
        path: '/projects/:projectId/tasks/new',
        component: () => import('@/view/CreateTaskView.vue'),
        meta: { titleKey: 'createTask', section: 'projects', contentWidth: 'form' },
    },
    {
        name: 'project-draft-edit',
        path: '/projects/:projectId/drafts/:draftId/edit',
        component: () => import('@/view/CreateTaskView.vue'),
        meta: { titleKey: 'createTask', section: 'projects', contentWidth: 'form' },
    },
] satisfies RouteRecordRaw[];
