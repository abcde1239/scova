import { describe, expect, it } from 'vite-plus/test';
import { createMemoryHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import { collectPages, createWorkbenchRouter, pageTitle } from '@/router';
import workbench from '@/router/pages/workbench';

describe('工作台路由契约', () => {
    it.each([
        ['/tasks', 'tasks', '任务'],
        ['/inbox', 'inbox', '收件箱'],
        ['/library', 'library', '资料库'],
        ['/notifications', 'notifications', '通知'],
        ['/account', 'account', '账号'],
        ['/account/agent', 'account', 'Agent 配置'],
        ['/account/appearance', 'account', '外观'],
    ])('%s 可直达且具有标题和所属导航', (path, section, title) => {
        const route = createWorkbenchRouter(createMemoryHistory()).resolve(path);
        expect(route.meta.section).toBe(section);
        expect(pageTitle(route)).toBe(`${title} · 知巡 Scova`);
    });

    it('未知路径保留 URL，命中未找到页且不高亮任何导航', () => {
        const route = createWorkbenchRouter(createMemoryHistory()).resolve('/missing/deep?x=1');
        expect(route.name).toBe('not-found');
        expect(route.fullPath).toBe('/missing/deep?x=1');
        expect(route.meta.section).toBeUndefined();
        expect(pageTitle(route)).toBe('页面未找到 · 知巡 Scova');
    });

    it('首页默认进入任务', () => {
        const route = createWorkbenchRouter(createMemoryHistory()).resolve('/');
        expect(route.matched[0]?.redirect).toBe('/tasks');
    });

    it.each([true, false])('领域模块按名称替换未接入入口，顺序为 %s', (first) => {
        const task: RouteRecordRaw = {
            name: 'tasks',
            path: '/tasks',
            component: { render: () => null },
            meta: { title: '研究任务' },
        };
        const pages = collectPages(first ? [[task], workbench] : [workbench, [task]]);
        const router = createWorkbenchRouter(createMemoryHistory(), pages);
        const route = router.resolve('/tasks');
        expect(route.meta.title).toBe('研究任务');
        expect(route.meta.pending).toBe(false);
        expect(route.meta.section).toBe('tasks');
        expect(route.meta.navigation).toBe('primary');
        expect(router.getRoutes().filter((item) => item.name === 'tasks')).toHaveLength(1);
    });

    it('无名称或重复真实页面不静默覆盖', () => {
        const page: RouteRecordRaw = { name: 'test', path: '/test', component: {} };
        expect(() => collectPages([[{ path: '/test', component: {} }]])).toThrow('必须具有名称');
        expect(() => collectPages([[page], [page]])).toThrow('重复登记');
    });

    it('独立详情模块保留所属导航与局部分区组件', () => {
        const view = { render: () => null };
        const detail: RouteRecordRaw = {
            name: 'task-detail',
            path: '/tasks/:id',
            components: { default: view, context: view, tools: view, reading: view },
            meta: { title: '任务详情', section: 'tasks' },
        };
        const pages = collectPages([workbench, [detail]]);
        const route = createWorkbenchRouter(createMemoryHistory(), pages).resolve('/tasks/123');
        expect(route.name).toBe('task-detail');
        expect(route.meta.section).toBe('tasks');
        expect(route.params.id).toBe('123');
        expect(Object.keys(route.matched[0]?.components ?? {})).toEqual([
            'default',
            'context',
            'tools',
            'reading',
        ]);
    });
});
