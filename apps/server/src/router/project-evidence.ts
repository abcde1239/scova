import { Elysia, t } from 'elysia';
import {
    ApiErrorSchema,
    ProjectReportEvidenceSchema,
    ProjectReportEvidenceSearchSchema,
    ProjectReportSearchQuerySchema,
    ProjectSourceEvidenceSchema,
    UuidSchema,
} from '@scova/models';
import type { ApiServices } from '@/app/services';
import { createProjectEvidenceHandlers } from '@/handler/project-evidence.ts';

const project = { projectId: UuidSchema };
const report = { ...project, reportId: UuidSchema };
const errors = {
    401: ApiErrorSchema,
    403: ApiErrorSchema,
    404: ApiErrorSchema,
    422: ApiErrorSchema,
} as const;

export function createProjectEvidencePlugin(services: ApiServices) {
    const handlers = createProjectEvidenceHandlers(services);
    return new Elysia({ name: 'scova-project-evidence', prefix: '/api/v1', normalize: false })
        .get('/projects/:projectId/evidence/reports', handlers.search, {
            params: t.Object(project),
            query: ProjectReportSearchQuerySchema,
            response: { 200: ProjectReportEvidenceSearchSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'searchProjectEvidenceReports',
                summary: '检索项目报告、结论和来源',
                description: '在仍属于当前项目的报告中匹配字面关键词。',
            },
        })
        .get('/projects/:projectId/evidence/reports/:reportId', handlers.report, {
            params: t.Object(report),
            response: { 200: ProjectReportEvidenceSchema, ...errors },
            detail: {
                tags: ['项目'],
                operationId: 'getProjectEvidenceReport',
                summary: '读取项目报告摘要与来源',
                description: '验证报告归属后返回摘要和保存的来源。',
            },
        })
        .get(
            '/projects/:projectId/evidence/reports/:reportId/sources/:snapshotId',
            handlers.source,
            {
                params: t.Object({ ...report, snapshotId: UuidSchema }),
                response: { 200: ProjectSourceEvidenceSchema, ...errors },
                detail: {
                    tags: ['项目'],
                    operationId: 'getProjectEvidenceSource',
                    summary: '读取项目报告的来源快照',
                    description: '仅返回该报告所引用且当前仍在项目内的来源快照。',
                },
            },
        );
}
