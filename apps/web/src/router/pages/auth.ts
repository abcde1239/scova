import type { RouteRecordRaw } from 'vue-router';
export default [
    {
        path: '/register',
        name: 'register',
        component: () => import('@/views/RegisterView.vue'),
        meta: { title: '注册', layout: 'auth' },
    },
    {
        path: '/login',
        name: 'login',
        component: () => import('@/views/LoginView.vue'),
        meta: { title: '登录', layout: 'auth' },
    },
] satisfies RouteRecordRaw[];
