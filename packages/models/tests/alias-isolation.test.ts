import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';

describe('monorepo importer 的 @ 别名隔离', () => {
    it('同一个 Vite 根中按所属 workspace 解析相同 @/index.ts', async () => {
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
                'agent-core',
                'connectors',
                'image-storage',
                'object-storage',
            ];
            for (const workspace of workspaces) {
                const importer = fileURLToPath(
                    new URL(`../../${workspace}/src/index.ts`, import.meta.url),
                );
                const result = await server.environments.ssr.pluginContainer.resolveId(
                    '@/index.ts',
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
