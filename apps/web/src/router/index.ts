import { createRouter, createWebHistory } from 'vue-router';
import type { RouteLocationNormalizedLoaded, RouteRecordRaw, RouterHistory } from 'vue-router';

declare module 'vue-router' {
    interface RouteMeta {
        title?: string;
        layout?: 'auth' | 'status';
        contentWidth?: 'form';
        section?: string;
        navigation?: 'primary' | 'tool';
        pending?: boolean;
    }
}

const fixtureModules =
    import.meta.env.MODE === 'test'
        ? import.meta.glob<{ default: RouteRecordRaw[] }>('../../tests/fixtures/routes.ts', {
              eager: true,
          })
        : {};

const modules = import.meta.glob<{ default: RouteRecordRaw[] }>('./pages/*.ts', { eager: true });

/** 已接入的独立领域模块可按同名替换壳层入口，两个真实实现不能互相覆盖。 */
export function collectPages(groups: RouteRecordRaw[][]): RouteRecordRaw[] {
    const pages = new Map<string | symbol, RouteRecordRaw>();
    for (const page of groups.flat()) {
        if (!page.name) throw new Error(`页面必须具有名称：${page.path}`);
        const previous = pages.get(page.name);
        if (!previous) pages.set(page.name, page);
        else if (previous.meta?.pending && !page.meta?.pending)
            pages.set(page.name, {
                ...page,
                meta: { ...previous.meta, ...page.meta, pending: false },
            });
        else if (!previous.meta?.pending && page.meta?.pending)
            pages.set(page.name, {
                ...previous,
                meta: { ...page.meta, ...previous.meta, pending: false },
            });
        else throw new Error(`页面重复登记：${String(page.name)}`);
    }
    return [...pages.values()];
}

export function pageTitle(route: Pick<RouteLocationNormalizedLoaded, 'meta'>): string {
    return `${route.meta.title ?? '页面'} · 知巡 Scova`;
}

export function createWorkbenchRouter(
    history: RouterHistory = createWebHistory(import.meta.env.BASE_URL),
    pages = collectPages(
        Object.values({ ...modules, ...fixtureModules }).map((module) => module.default),
    ),
) {
    return createRouter({
        history,
        routes: [
            { path: '/', redirect: '/tasks' },
            ...pages,
            {
                path: '/service-unavailable',
                name: 'service-unavailable',
                component: () => import('@/views/ServiceUnavailableView.vue'),
                meta: { title: '暂时无法连接服务', layout: 'status' },
            },
            {
                path: '/:pathMatch(.*)*',
                name: 'not-found',
                component: () => import('@/views/RouteStatusView.vue'),
                meta: { title: '页面未找到' },
            },
        ],
    });
}
