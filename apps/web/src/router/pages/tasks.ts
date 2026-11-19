import type { RouteRecordRaw } from 'vue-router';
const component = () => import('@/view/TaskCenterView.vue');
export default [
    { name: 'tasks', path: '/tasks', component, meta: { titleKey: 'tasks', section: 'tasks' } },
    {
        name: 'task-create',
        path: '/tasks/new',
        component: () => import('@/view/CreateTaskView.vue'),
        meta: { titleKey: 'createTask', section: 'tasks', contentWidth: 'form' },
    },
    {
        name: 'task-edit',
        path: '/tasks/:taskId/edit',
        component: () => import('@/view/EditTaskView.vue'),
        meta: { titleKey: 'editTask', section: 'tasks', contentWidth: 'form' },
    },
    {
        name: 'task-summary',
        path: '/tasks/:taskId',
        components: {
            default: component,
            tools: () => import('@/component/tasks/TaskSummaryTools.vue'),
        },
        meta: { titleKey: 'taskSummary', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
