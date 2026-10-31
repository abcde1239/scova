import { defineConfig } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { presetWind3 } from 'unocss';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
    resolve: { tsconfigPaths: true },
    ...(mode === 'test'
        ? {
              build: {
                  rolldownOptions: {
                      input: {
                          main: fileURLToPath(new URL('./index.html', import.meta.url)),
                          reportTopicList: fileURLToPath(
                              new URL('./test-fixtures/report-topic-list.html', import.meta.url),
                          ),
                          reportComparison: fileURLToPath(
                              new URL('./test-fixtures/report-comparison.html', import.meta.url),
                          ),
                      },
                  },
              },
          }
        : {}),
    plugins: [
        vue(),
        UnoCSS({
            presets: [presetWind3()],
            shortcuts: {
                'page-container': 'mx-auto w-full max-w-5xl px-6 py-12',
                'theme-surface': 'bg-[var(--scova-surface)] text-[var(--scova-text)]',
                'theme-selected': 'bg-[var(--scova-selected)] text-[var(--scova-primary)]',
                'theme-reference': 'text-[var(--scova-primary)] underline underline-offset-[0.2em]',
                'theme-partial': 'text-[var(--scova-partial)]',
                'theme-failure': 'text-[var(--scova-danger)]',
            },
        }),
    ],
}));
