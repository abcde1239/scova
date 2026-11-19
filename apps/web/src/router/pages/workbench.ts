import type { RouteRecordRaw } from 'vue-router';

const statusView = () => import('@/view/RouteStatusView.vue');

export default [
    {
        path: '/tasks',
        name: 'tasks',
        component: statusView,
        meta: { titleKey: 'tasks', section: 'tasks', navigation: 'primary', pending: true },
    },
    {
        path: '/inbox',
        name: 'inbox',
        component: statusView,
        meta: { titleKey: 'inbox', section: 'inbox', navigation: 'primary', pending: true },
    },
    {
        path: '/library',
        name: 'library',
        component: statusView,
        meta: { titleKey: 'library', section: 'library', navigation: 'primary', pending: true },
    },
    {
        path: '/notifications',
        name: 'notifications',
        component: statusView,
        meta: {
            titleKey: 'notifications',
            section: 'notifications',
            navigation: 'tool',
            pending: true,
        },
    },
    {
        path: '/account',
        name: 'account',
        component: () => import('@/view/SettingsView.vue'),
        meta: { titleKey: 'account', section: 'account', navigation: 'tool', contentWidth: 'form' },
    },
    {
        path: '/account/agent',
        name: 'agent-settings',
        component: () => import('@/view/AgentSettingsView.vue'),
        meta: { titleKey: 'agent', section: 'account', contentWidth: 'form' },
    },
    {
        path: '/account/appearance',
        name: 'appearance',
        component: statusView,
        meta: { titleKey: 'appearance', section: 'account', contentWidth: 'form' },
    },
] satisfies RouteRecordRaw[];
