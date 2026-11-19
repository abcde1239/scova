import {
    ReportSchema,
    ReportExportSchema,
    type ReportExport,
    ReportListQuerySchema,
    ReportListResponseSchema,
    UuidSchema,
    parseContract,
    type Report,
    type ReportListQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export type ReportHistoryPage = typeof ReportListResponseSchema.static;
export type ReportHistoryItem = ReportHistoryPage['items'][number];
export const reportHistoryEndpoint = defineApiEndpoint<{
    query: ReportListQuery;
    data: ReportHistoryPage;
}>({
    method: 'GET',
    path: '/reports',
    inputValidators: { query: modelValidator(ReportListQuerySchema) },
    validator: modelValidator(ReportListResponseSchema),
});

const reportParamsValidator = {
    parse(value: unknown) {
        const id =
            value && typeof value === 'object' && 'reportId' in value ? value.reportId : undefined;
        return { reportId: parseContract(UuidSchema, id) };
    },
};
export const reportExportEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    data: ReportExport;
}>({
    method: 'POST',
    path: '/reports/:reportId/exports/markdown',
    inputValidators: { params: reportParamsValidator },
    validator: modelValidator(ReportExportSchema),
});

export const reportEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    data: Report;
}>({
    method: 'GET',
    path: '/reports/:reportId',
    inputValidators: { params: reportParamsValidator },
    validator: modelValidator(ReportSchema),
});
