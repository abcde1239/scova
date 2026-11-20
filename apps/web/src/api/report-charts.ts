import {
    REPORT_CHART_MAX_BYTES,
    ReportSourceHostChartSchema,
    UuidSchema,
    parseContract,
    type ReportSourceHostChart,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

type ReportParams = { reportId: string };
type ChartParams = ReportParams & { chartId: string };

export const reportResourceParams = {
    parse(value: ReportParams) {
        return { reportId: parseContract(UuidSchema, value?.reportId) };
    },
};

export function reportDownloadValidator(mimeType: string, maxBytes: number) {
    return {
        parse(blob: unknown) {
            if (
                !(blob instanceof Blob) ||
                blob.type.split(';')[0] !== mimeType ||
                !blob.size ||
                blob.size > maxBytes
            )
                throw new TypeError('下载的资源格式或大小无效');
            return blob;
        },
    };
}

export const generateReportChartEndpoint = defineApiEndpoint<{
    params: ReportParams;
    data: ReportSourceHostChart;
}>({
    method: 'POST',
    path: '/reports/:reportId/charts/source-hosts',
    inputValidators: { params: reportResourceParams },
    validator: modelValidator(ReportSourceHostChartSchema),
});

export const downloadReportChartEndpoint = defineApiEndpoint<{ params: ChartParams; data: Blob }>({
    method: 'GET',
    path: '/reports/:reportId/charts/:chartId/download',
    responseType: 'blob',
    inputValidators: {
        params: {
            parse: (value: ChartParams) => ({
                ...reportResourceParams.parse(value),
                chartId: parseContract(UuidSchema, value?.chartId),
            }),
        },
    },
    validator: reportDownloadValidator('image/svg+xml', REPORT_CHART_MAX_BYTES),
});
