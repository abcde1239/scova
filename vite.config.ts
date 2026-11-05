import { defineConfig } from 'vite-plus';
import { verificationTasks } from './tests/tasks.ts';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    staged: {
        '*': 'vp check --fix',
    },
    fmt: {
        ignorePatterns: ['scripts/vendor/**', '.pnpm-store/**'],
        singleQuote: true,
        tabWidth: 4,
        printWidth: 100,
    },
    lint: {
        ignorePatterns: ['scripts/vendor/**', '.pnpm-store/**'],
        jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
        rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
        options: { typeAware: true, typeCheck: true },
    },
    test: {
        env: { VITE_API_BASE_URL: '/api/v1' },
        include: ['{apps,packages}/*/{src,tests}/**/*.{test,spec}.ts'],
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/artifacts/**',
            '**/coverage/**',
            '**/e2e/**',
            '**/*.integration.test.ts',
        ],
    },
    run: {
        // 治理入口读取 Git index，必须每次执行；需要缓存的构建另用显式 task 配置。
        cache: { scripts: false, tasks: true },
        tasks: verificationTasks,
    },
});
