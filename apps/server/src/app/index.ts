import { swagger } from '@elysiajs/swagger';
import { node } from '@elysiajs/node';
import { Elysia } from 'elysia';
import { contractModels, HealthResponseSchema } from '@/app/contracts.ts';
import { createApiErrorPlugin } from '@/app/errors.ts';
import { createDefaultServices, type ApiServices } from '@/app/services';
import { createAuthPlugin } from '@/router/auth.ts';
import { createTaskPlugin } from '@/router/tasks.ts';
import { createTaskDraftPlugin } from '@/router/task-drafts.ts';
import { createLibraryPlugin } from '@/router/library.ts';
import { createRunPlugin } from '@/router/runs.ts';
import { createReportQuestionPlugin } from '@/router/report-questions.ts';
import { createReportPlugin } from '@/router/reports.ts';
import { createNotificationPlugin } from '@/router/notifications.ts';
import { createSystemPlugin } from '@/router/system.ts';
import { createFeedbackPlugin } from '@/router/feedback.ts';
import { createCorsPlugin } from '@/http/cors';
import { createAgentProviderPlugin } from '@/router/agent-providers';

export { contractModels, HealthResponseSchema } from '@/app/contracts.ts';

export const createApiApp = (
    _runtime: 'bun' | 'node' = 'bun',
    services: ApiServices = createDefaultServices(),
) =>
    new Elysia({
        name: 'scova-api',
        normalize: false,
        adapter: node(),
    })
        .use(createApiErrorPlugin())
        .use(createCorsPlugin(services.origin))
        .model({ ...contractModels, HealthResponse: HealthResponseSchema } as unknown as Record<
            string,
            import('elysia').TSchema
        >)
        .use(
            swagger({
                documentation: {
                    info: {
                        title: 'Scova API',
                        version: '1.0.0',
                        description:
                            'Scova 后端接口文档。成功返回领域 JSON:错误使用 HTTP 状态与 code/message/requestId/fieldErrors。',
                    },
                    openapi: '3.1.0',
                    tags: [{ name: '系统', description: '服务运行状态接口' }],
                },
            }),
        )
        .use(createSystemPlugin())
        .use(createAuthPlugin(services))
        .use(createAgentProviderPlugin(services))
        .use(createTaskPlugin(services))
        .use(createTaskDraftPlugin(services))
        .use(createFeedbackPlugin(services))
        .use(createRunPlugin(services))
        .use(createReportPlugin(services))
        .use(createLibraryPlugin(services))
        .use(createNotificationPlugin(services))
        .use(createReportQuestionPlugin(services))
        .onStop(() => services.streams.stop());
