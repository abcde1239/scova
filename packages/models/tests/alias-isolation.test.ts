import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';

describe('monorepo importer 的 @ 别名隔离', () => {
    it('同一个 Vite 根中按所属 workspace 解析 @ 别名', async () => {
        const root = fileURLToPath(new URL('../../../', import.meta.url));
        const server = await createServer({
            root,
            configFile: false,
            resolve: { tsconfigPaths: true },
            server: { middlewareMode: true, watch: null },
        });
        try {
            const resolved = [];
            const workspaces = [
                'models',
                'db',
                'shared',
                'execution',
                'agent-core',
                'connectors',
                'object-storage',
            ];
            for (const workspace of workspaces) {
                const entry = { shared: 'schedule.ts', execution: 'protocol.ts' } as const;
                const file =
                    workspace === 'shared' || workspace === 'execution'
                        ? entry[workspace]
                        : 'index.ts';
                const importer = fileURLToPath(
                    new URL(`../../${workspace}/src/${file}`, import.meta.url),
                );
                const result = await server.environments.ssr.pluginContainer.resolveId(
                    `@/${file}`,
                    importer,
                );
                expect(result?.id, workspace).toBeTruthy();
                const target = await realpath(result!.id);
                expect(target).toBe(await realpath(importer));
                resolved.push(target);
            }
            expect(new Set(resolved).size).toBe(workspaces.length);
        } finally {
            await server.close();
        }
    });
});
