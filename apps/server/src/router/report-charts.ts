import { ApiErrorSchema, ReportSourceHostChartSchema, UuidSchema } from '@scova/models';
import { Elysia, t } from 'elysia';
import type { ApiServices } from '@/app/services';
import { createReportChartHandlers } from '@/handler/report-charts.ts';

export function createReportChartPlugin(services: ApiServices) {
    const handlers = createReportChartHandlers(services);
    const errors = {
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema,
        409: ApiErrorSchema,
        410: ApiErrorSchema,
        422: ApiErrorSchema,
    } as const;
    return new Elysia({
        name: 'scova-report-charts',
        prefix: '/api/v1/reports/:reportId/charts',
        normalize: false,
    })
        .onBeforeHandle(({ set }) => {
            set.headers['cache-control'] = 'private, no-store';
        })
        .post(
            '/source-hosts',
            ({ request, params }) => handlers.generate(request, params.reportId),
            {
                params: t.Object({ reportId: UuidSchema }),
                response: { 200: ReportSourceHostChartSchema, ...errors },
                detail: {
                    operationId: 'generateReportSourceHostChart',
                    tags: ['报告'],
                    summary: '生成报告引用来源主机名图表及等价表格',
                    description:
                        '需要本人会话和请求校验。对已交付报告的网页引用按主机名去重统计，并返回可追溯的引用标识。',
                },
            },
        )
        .get(
            '/:chartId',
            ({ request, params }) => handlers.get(request, params.reportId, params.chartId),
            {
                params: t.Object({ reportId: UuidSchema, chartId: UuidSchema }),
                response: { 200: ReportSourceHostChartSchema, ...errors },
                detail: {
                    operationId: 'getReportSourceHostChart',
                    tags: ['报告'],
                    summary: '读取已引用的报告图表及来源表格',
                    description: '仅本人会话可读取报告保留的图表引用，下载到期后仍可读取等价表格。',
                },
            },
        )
        .get(
            '/:chartId/download',
            ({ request, params }) => handlers.download(request, params.reportId, params.chartId),
            {
                params: t.Object({ reportId: UuidSchema, chartId: UuidSchema }),
                response: { 200: t.Any(), ...errors },
                detail: {
                    operationId: 'downloadReportSourceHostChart',
                    tags: ['报告'],
                    summary: '下载本人报告的 SVG 图表',
                    description:
                        '仅本人会话可下载。下载有效期为二十四小时，过期后可重新生成同一图表。',
                    responses: {
                        200: {
                            description: '可下载的 SVG 图表',
                            content: {
                                'image/svg+xml': { schema: { type: 'string', format: 'binary' } },
                            },
                        },
                    },
                },
            },
        );
}
