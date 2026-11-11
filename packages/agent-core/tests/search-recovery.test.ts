import { describe, expect, it } from 'vite-plus/test';
import {
    diversifyQueries,
    boundedRecoveryQuery,
    confirmsRequestedVersion,
    matchesQueryVersion,
    matchesRetrievalTarget,
    matchesSiteModule,
    objectRecoveryQuery,
    relaxSitePath,
    retrievalTargets,
} from '../src/search-recovery.ts';

describe('bounded source discovery recovery', () => {
    it('relaxes only the site path and preserves version, language and module tokens', () => {
        expect(relaxSitePath('Node.js HTTP site:nodejs.org/docs/v22.12.0/api/http.html')).toBe(
            'Node.js HTTP site:nodejs.org "v22.12.0" "http"',
        );
        expect(relaxSitePath('Python site:"docs.python.org/3.13/zh-cn/library/json.html"')).toBe(
            'Python site:docs.python.org "3.13" "zh-cn" "json"',
        );
        expect(relaxSitePath('site:nodejs.org HTTP')).toBeNull();
        expect(relaxSitePath('HTTP without a site restriction')).toBeNull();
    });
    it('does not relax credentials or non-HTTP operators into a new source', () => {
        expect(relaxSitePath('site:https://user:pass@example.com/api/http.html')).toBeNull();
        expect(relaxSitePath('site:file:///api/http.html')).toBeNull();
    });
    it('rejects a contradictory explicit version but permits unknown or less specific versions', () => {
        const query = 'HTTP site:nodejs.org/docs/v22.12.0/api/http.html';
        expect(
            matchesQueryVersion(query, {
                title: 'HTTP Node.js v24.1.0',
                url: 'https://nodejs.org/docs/v24.1.0/api/http.html',
            }),
        ).toBe(false);
        expect(
            matchesQueryVersion(query, {
                title: 'HTTP',
                url: 'https://nodejs.org/docs/v22.11.0/api/http.html',
            }),
        ).toBe(false);
        expect(
            matchesQueryVersion(query, {
                title: 'HTTP Node.js v22',
                url: 'https://nodejs.org/api/http.html',
            }),
        ).toBe(true);
        expect(
            matchesQueryVersion(query, { title: 'HTTP', url: 'https://nodejs.org/api/http.html' }),
        ).toBe(true);
        expect(
            matchesQueryVersion('Python 3.13 json', {
                title: 'json — Python 3.12 documentation',
                url: 'https://docs.python.org/3.12/library/json.html',
            }),
        ).toBe(false);
    });
    it('keeps unknown versions distinct from confirmed requested or current versions', () => {
        expect(
            confirmsRequestedVersion('PostgreSQL current', {
                title: 'Transaction isolation',
                url: 'https://www.postgresql.org/docs/7.4/transaction-iso.html',
            }),
        ).toBe(false);
        expect(
            confirmsRequestedVersion('PostgreSQL current', {
                title: 'Transaction isolation',
                url: 'https://www.postgresql.org/docs/current/transaction-iso.html',
            }),
        ).toBe(true);
        expect(
            confirmsRequestedVersion('PostgreSQL current', {
                title: 'Transaction isolation',
                originalUrl: 'https://www.postgresql.org/docs/current/transaction-iso.html',
                url: 'https://www.postgresql.org/docs/18/transaction-iso.html',
            }),
        ).toBe(true);
        expect(
            confirmsRequestedVersion('Python 3.13 json', {
                title: 'JSON documentation',
                url: 'https://docs.example/json.html',
            }),
        ).toBe(false);
        expect(
            confirmsRequestedVersion('current prices', {
                title: 'Prices',
                url: 'https://example.com/prices',
            }),
        ).toBe(true);
    });
    it('fits recovery queries within 100 Unicode characters without dropping version or module', () => {
        const relaxed = relaxSitePath(
            `${'long optional terms '.repeat(8)}site:nodejs.org/docs/v22.12.0/api/http.html`,
        )!;
        expect(relaxed.length).toBeLessThanOrEqual(100);
        expect(relaxed).toContain('site:nodejs.org');
        expect(relaxed).toContain('"v22.12.0" "http"');
        const target = {
            object: 'json',
            fields: ['很长的属性说明'.repeat(40)],
            questionIds: ['q0'],
        };
        const focused = objectRecoveryQuery('Python '.repeat(30), 'Python 3.13', target, [target]);
        expect(focused.length).toBeLessThanOrEqual(100);
        expect(focused).toContain('Python 3.13');
        expect(focused).toContain('json');
        expect(boundedRecoveryQuery('😀'.repeat(200)).length).toBe(100);
        expect(Array.from(boundedRecoveryQuery('😀'.repeat(200)))).toHaveLength(50);
        expect(
            relaxSitePath(`site:${'a'.repeat(80)}.example/docs/v22.12.0/api/http.html`),
        ).toBeNull();
    });
    it('does not cover sibling modules from substring overlap or navigation text', () => {
        const target = { object: 'watch', fields: ['清理'], questionIds: ['q0'] };
        expect(
            matchesRetrievalTarget(target, {
                title: 'watchEffect',
                url: 'https://vuejs.org/api/watchEffect.html',
            }),
        ).toBe(false);
        expect(
            matchesRetrievalTarget(target, {
                title: 'watch()',
                url: 'https://vuejs.org/api/watch.html',
            }),
        ).toBe(true);
        expect(
            matchesRetrievalTarget(
                { ...target, object: 'json' },
                {
                    title: 'pathlib — Python documentation',
                    url: 'https://docs.python.org/3.13/library/pathlib.html',
                },
            ),
        ).toBe(false);
        expect(
            matchesRetrievalTarget(
                { ...target, object: 'Node.js HTTP' },
                { title: 'HTTP', url: 'https://nodejs.org/api/http.html' },
            ),
        ).toBe(true);
        expect(
            matchesRetrievalTarget(
                { ...target, object: 'http' },
                { title: 'HTTP/2', url: 'https://nodejs.org/api/http2.html' },
            ),
        ).toBe(false);
        expect(
            matchesRetrievalTarget(
                { ...target, object: 'http' },
                { title: 'Stream', url: 'https://nodejs.org/api/stream.html' },
            ),
        ).toBe(false);
    });
    it('does not accept a sibling module for an exact document path', () => {
        const query = 'HTTP site:nodejs.org/docs/v22.12.0/api/http.html';
        expect(
            matchesSiteModule(query, {
                title: 'Streams',
                url: 'https://nodejs.org/docs/v22.12.0/api/stream.html',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule(query, { title: 'HTTP/2', url: 'https://nodejs.org/api/http2.html' }),
        ).toBe(false);
        expect(
            matchesSiteModule(query, { title: 'HTTP', url: 'https://nodejs.org/api/http.html' }),
        ).toBe(true);
        expect(
            matchesSiteModule(query, {
                title: 'HTTP overview',
                url: 'https://nodejs.org/learn/http-overview',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule(query, { title: 'HTTP', url: 'https://nodejs.org/api/http.md' }),
        ).toBe(true);
        expect(
            matchesSiteModule(query, { title: 'HTTP', url: 'https://nodejs.org/api/http' }),
        ).toBe(true);
        expect(
            matchesSiteModule('site:nginx.org/en/docs/http/ngx_http_core_module.html', {
                title: 'HTTP core module',
                url: 'https://nginx.org/en/docs/stream/ngx_stream_core_module.html',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule('site:nginx.org/en/docs/http/ngx_http_core_module.html', {
                title: 'HTTP core module mailing list',
                url: 'https://mailman.nginx.org/pipermail/nginx/2026/thread.html',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule('site:www.postgresql.org/docs/current/transaction-iso.html', {
                title: 'Transaction isolation message',
                url: 'https://www.postgresql.org/message-id/thread.html',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule('site:www.postgresql.org/docs/current/', {
                title: 'Transaction isolation message',
                url: 'https://www.postgresql.org/message-id/transaction-iso.html',
            }),
        ).toBe(false);
        expect(
            matchesSiteModule('site:nginx.org/en/docs/http/ngx_http_core_module.html', {
                title: 'HTTP core module',
                url: 'https://nginx.org/ru/docs/http/ngx_http_core_module.html',
            }),
        ).toBe(true);
        expect(
            matchesSiteModule('site:nodejs.org HTTP', {
                title: 'Streams',
                url: 'https://nodejs.org/api/stream.html',
            }),
        ).toBe(true);
    });
    it('accepts the canonical www alias without admitting other subdomains', () => {
        const query = 'site:postgresql.org/docs/current/transaction-iso.html';
        expect(
            matchesSiteModule(query, {
                title: 'Transaction isolation',
                url: 'https://www.postgresql.org/docs/current/transaction-iso.html',
            }),
        ).toBe(true);
        expect(
            matchesSiteModule(query, {
                title: 'Transaction isolation',
                url: 'https://mailman.postgresql.org/docs/current/transaction-iso.html',
            }),
        ).toBe(false);
    });
    it('deduplicates the fixed object plan and omits optional or context-only fields', () => {
        const base = {
            id: 'a',
            format: 'brief' as const,
            questionIds: ['q0'],
            object: 'pathlib',
            field: '接口',
            required: true,
        };
        expect(
            retrievalTargets([
                base,
                { ...base, id: 'b', format: 'list', questionIds: ['q1'], field: '限制' },
                { ...base, object: '', id: 'c' },
                { ...base, object: 'json', required: false, id: 'd' },
            ]),
        ).toEqual([{ object: 'pathlib', questionIds: ['q0', 'q1'], fields: ['接口', '限制'] }]);
    });
    it('focuses the missing object while retaining the requested family and explicit version', () => {
        const targets = ['pathlib', 'json', 'datetime'].map((object) => ({
            object,
            questionIds: ['q0'],
            fields: ['接口与限制'],
        }));
        const query = objectRecoveryQuery(
            'Python pathlib json datetime',
            '只查 Python 3.13 文档',
            targets[1]!,
            targets,
        );
        expect(query).toContain('Python 3.13');
        expect(query).toContain('json');
        expect(query).not.toMatch(/pathlib|datetime/);
        const watcher = objectRecoveryQuery(
            'Vue watch watchEffect',
            'Vue watch watchEffect',
            { object: 'watchEffect', questionIds: ['q0'], fields: [] },
            [
                { object: 'watch', questionIds: ['q0'], fields: [] },
                { object: 'watchEffect', questionIds: ['q0'], fields: [] },
            ],
        );
        expect(watcher).toContain('watchEffect');
    });
    it('allocates a small initial search budget across distinct questions before repeated queries', () => {
        const queries = [
            { query: 'first q0', questionIds: ['q0'] },
            { query: 'again q0', questionIds: ['q0'] },
            { query: 'first q1', questionIds: ['q1'] },
        ];
        expect(
            diversifyQueries(queries)
                .slice(0, 2)
                .map((item) => item.questionIds),
        ).toEqual([['q0'], ['q1']]);
        expect(queries.map((item) => item.query)).toEqual(['first q0', 'again q0', 'first q1']);
        const targets = ['pathlib', 'json'].map((object) => ({
            object,
            fields: [],
            questionIds: ['q0'],
        }));
        expect(
            diversifyQueries(
                [
                    { query: 'Python pathlib', questionIds: ['q0'] },
                    { query: 'Python pathlib methods', questionIds: ['q0'] },
                    { query: 'Python json', questionIds: ['q0'] },
                ],
                targets,
            )
                .slice(0, 2)
                .map((item) => item.query),
        ).toEqual(['Python pathlib', 'Python json']);
    });
});
