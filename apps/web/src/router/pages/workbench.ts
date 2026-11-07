import type { RouteRecordRaw } from 'vue-router';

const statusView = () => import('@/views/RouteStatusView.vue');

export default [
    {
        path: '/tasks',
        name: 'tasks',
        component: statusView,
        meta: { title: '任务', section: 'tasks', navigation: 'primary', pending: true },
    },
    {
        path: '/inbox',
        name: 'inbox',
        component: statusView,
        meta: { title: '收件箱', section: 'inbox', navigation: 'primary', pending: true },
    },
    {
        path: '/library',
        name: 'library',
        component: statusView,
        meta: { title: '资料库', section: 'library', navigation: 'primary', pending: true },
    },
    {
        path: '/notifications',
        name: 'notifications',
        component: statusView,
        meta: { title: '通知', section: 'notifications', navigation: 'tool', pending: true },
    },
    {
        path: '/account',
        name: 'account',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '账号', section: 'account', navigation: 'tool', contentWidth: 'form' },
    },
    {
        path: '/account/agent',
        name: 'agent-settings',
        component: () => import('@/views/AgentSettingsView.vue'),
        meta: { title: 'Agent 配置', section: 'account', contentWidth: 'form' },
    },
    {
        path: '/account/appearance',
        name: 'appearance',
        component: statusView,
        meta: { title: '外观', section: 'account', contentWidth: 'form' },
    },
] satisfies RouteRecordRaw[];
