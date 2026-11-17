import type { RouteRecordRaw } from 'vue-router';
const component = () => import('@/views/TaskCenterView.vue');
export default [
    { name: 'tasks', path: '/tasks', component, meta: { title: '任务', section: 'tasks' } },
    {
        name: 'task-create',
        path: '/tasks/new',
        component: () => import('@/views/CreateTaskView.vue'),
        meta: { title: '新建任务', section: 'tasks', contentWidth: 'form' },
    },
    {
        name: 'task-edit',
        path: '/tasks/:taskId/edit',
        component: () => import('@/views/EditTaskView.vue'),
        meta: { title: '编辑任务', section: 'tasks', contentWidth: 'form' },
    },
    {
        name: 'task-summary',
        path: '/tasks/:taskId',
        components: {
            default: component,
            tools: () => import('@/components/tasks/TaskSummaryTools.vue'),
        },
        meta: { title: '任务摘要', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
