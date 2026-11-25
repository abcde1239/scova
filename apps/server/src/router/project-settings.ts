import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    PatchProjectSettingsSchema,
    ProjectSettingsSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectSettingsHandlers } from '@/handler/project-settings.ts';

const params = t.Object({ projectId: UuidSchema });
const errors = {
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    422: ApiErrorSchema,
} as const;

export function createProjectSettingsPlugin(services: ApiServices) {
    const handlers = createProjectSettingsHandlers(services);
    return new Elysia({ name: 'scova-project-settings', prefix: '/api/v1', normalize: false })
        .get('/projects/:projectId/settings', handlers.read, {
            params,
            response: { 200: ProjectSettingsSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'getProjectSettings',
                summary: '查看项目设定',
                description: '读取本人项目的长期要求、常用来源和默认自主度。',
            },
        })
        .patch('/projects/:projectId/settings', handlers.update, {
            params,
            body: PatchProjectSettingsSchema,
            response: { 200: ProjectSettingsSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'patchProjectSettings',
                summary: '保存项目设定',
                description: '用户提交的显式保存操作，需要会话与 CSRF 校验。',
            },
        });
}
