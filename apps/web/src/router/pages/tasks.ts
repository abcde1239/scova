import type { RouteRecordRaw } from 'vue-router';
const component = () => import('@/views/TaskCenterView.vue');
export default [
    { name: 'tasks', path: '/tasks', component, meta: { title: '任务', section: 'tasks' } },
    {
        name: 'task-summary',
        path: '/tasks/:taskId',
        component,
        meta: { title: '任务摘要', section: 'tasks' },
    },
] satisfies RouteRecordRaw[];
