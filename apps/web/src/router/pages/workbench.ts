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
        component: statusView,
        meta: { title: '账号', section: 'account', navigation: 'tool', pending: true },
    },
    {
        path: '/account/appearance',
        name: 'appearance',
        component: statusView,
        meta: { title: '外观', section: 'account' },
    },
] satisfies RouteRecordRaw[];
