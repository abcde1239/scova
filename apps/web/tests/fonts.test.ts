import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const web = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(file, 'utf8');
const packageRoot = (name: string) =>
    path.dirname(require.resolve(`@fontsource-variable/${name}/package.json`));
const chinese = '任务收件箱资料库通知外观账号研究报告来源引用事实推断冲突证据';

describe('自托管字体交付契约', () => {
    it.each(['inter', 'noto-sans-sc', 'noto-serif-sc'])('%s 保留发行许可和必需字重', (name) => {
        const root = packageRoot(name);
        const metadata = JSON.parse(read(path.join(root, 'metadata.json')));
        expect(metadata.license.type).toBe('OFL-1.1');
        expect(metadata.weights).toEqual(expect.arrayContaining([400, 500, 600]));
        expect(read(path.join(web, 'public/fonts/LICENSES.txt')).replace(/\r\n/g, '\n')).toContain(
            read(path.join(root, 'LICENSE')).replace(/\r\n/g, '\n').trim(),
        );
    });

    it.each(['noto-sans-sc', 'noto-serif-sc'])(
        '%s 中文分片覆盖界面样本，资源有效且预算有界',
        (name) => {
            const root = packageRoot(name);
            const css = read(path.join(root, 'wght.css'));
            const blocks = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]!);
            const ranges = blocks.flatMap((block) =>
                block
                    .match(/unicode-range:\s*([^;]+)/)![1]!
                    .split(',')
                    .map((range) => {
                        const [start, end = start] = range.trim().slice(2).split('-');
                        return [parseInt(start!, 16), parseInt(end!, 16)] as const;
                    }),
            );
            for (const character of chinese) {
                const code = character.codePointAt(0)!;
                expect(ranges.some(([start, end]) => code >= start && code <= end)).toBe(true);
            }
            let bytes = 0;
            for (const block of blocks) {
                expect(block).toMatch(/font-display:\s*swap/);
                expect(block).toMatch(/font-weight:\s*(100|200) 900/);
                const file = path.join(root, block.match(/url\(([^)]+)\)/)![1]!);
                expect(readFileSync(file).subarray(0, 4).toString()).toBe('wOF2');
                bytes += statSync(file).size;
            }
            expect(bytes).toBeLessThan(name === 'noto-sans-sc' ? 5 * 1024 * 1024 : 6 * 1024 * 1024);
        },
    );

    it('加载声明无外部 URL、无根字号覆盖，阅读字体独立消费', () => {
        const css = read(path.join(web, 'src/styles/fonts.css'));
        const reading = read(path.join(web, 'src/styles/reading-fonts.css'));
        expect(css + reading).not.toMatch(/https?:|font-size|font-size-adjust/);
        expect(css).toContain('font-display: swap');
        expect(css).not.toContain("@import '@fontsource-variable/noto-serif-sc");
        expect(reading).toContain('@fontsource-variable/noto-serif-sc/wght.css');
        const latin = path.join(packageRoot('inter'), 'files/inter-latin-wght-normal.woff2');
        expect(readFileSync(latin).subarray(0, 4).toString()).toBe('wOF2');
        expect(statSync(latin).size).toBeLessThan(50 * 1024);
    });
});
