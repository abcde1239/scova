import { defineConfig, loadEnv } from 'vite-plus';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { fileURLToPath } from 'node:url';

const envDir = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, envDir, ['APP_ORIGIN']);
    const origin = new URL(env.APP_ORIGIN || 'http://localhost:5173');
    return {
        envDir,
        resolve: { tsconfigPaths: true },
        server: {
            host: origin.hostname,
            port: Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)),
            strictPort: true,
            fs: {
                deny: [
                    '.env',
                    '.env.*',
                    '*.{crt,pem}',
                    '**/.git/**',
                    '**/*.sqlite',
                    '**/*.sqlite-*',
                ],
            },
        },
        ...(mode === 'test'
            ? {
                  build: {
                      rolldownOptions: {
                          input: {
                              main: fileURLToPath(new URL('./index.html', import.meta.url)),
                              reportTopicList: fileURLToPath(
                                  new URL(
                                      './tests/fixtures/reports/report-topic-list.html',
                                      import.meta.url,
                                  ),
                              ),
                              reportComparison: fileURLToPath(
                                  new URL(
                                      './tests/fixtures/reports/report-comparison.html',
                                      import.meta.url,
                                  ),
                              ),
                              reportResearch: fileURLToPath(
                                  new URL(
                                      './tests/fixtures/reports/report-research.html',
                                      import.meta.url,
                                  ),
                              ),
                          },
                      },
                  },
                  preview: {
                      proxy: {
                          '/api/v1': {
                              target: 'http://127.0.0.1:4190',
                          },
                      },
                  },
              }
            : {}),
        plugins: [
            vue(),
            UnoCSS({ configFile: fileURLToPath(new URL('./unocss.config.ts', import.meta.url)) }),
        ],
    };
});
