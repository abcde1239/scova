import type { RouteRecordRaw } from 'vue-router';
export default [
    {
        path: '/register',
        name: 'register',
        component: () => import('@/view/RegisterView.vue'),
        meta: { titleKey: 'register', layout: 'auth' },
    },
    {
        path: '/login',
        name: 'login',
        component: () => import('@/view/LoginView.vue'),
        meta: { titleKey: 'login', layout: 'auth' },
    },
] satisfies RouteRecordRaw[];
