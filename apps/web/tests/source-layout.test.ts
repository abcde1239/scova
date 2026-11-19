import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vite-plus/test';

it('component 及其子目录只存放 Vue 单文件组件', () => {
    const root = fileURLToPath(new URL('../src/component/', import.meta.url));
    const misplaced = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => !entry.isDirectory() && !entry.name.endsWith('.vue'))
        .map((entry) => relative(root, join(entry.parentPath, entry.name)));
    expect(misplaced).toEqual([]);
});
