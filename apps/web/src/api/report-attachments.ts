import {
    REPORT_ATTACHMENT_MAX_BYTES,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    ReportAttachmentDeletedSchema,
    ReportAttachmentFilenameSchema,
    ReportAttachmentListSchema,
    ReportAttachmentRowsSchema,
    ReportAttachmentSchema,
    UuidSchema,
    parseContract,
    type ReportAttachment,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import { reportDownloadValidator, reportResourceParams } from '@/api/report-charts';

type ReportParams = { reportId: string };
type AttachmentParams = ReportParams & { attachmentId: string };
type RowRange = { start: number; end: number };
const attachmentParams = {
    parse(value: AttachmentParams) {
        return {
            ...reportResourceParams.parse(value),
            attachmentId: parseContract(UuidSchema, value?.attachmentId),
        };
    },
};

export const reportAttachmentsEndpoint = defineApiEndpoint<{
    params: ReportParams;
    data: { items: ReportAttachment[] };
}>({
    method: 'GET',
    path: '/reports/:reportId/attachments',
    inputValidators: { params: reportResourceParams },
    validator: modelValidator(ReportAttachmentListSchema),
});

export const uploadReportAttachmentEndpoint = defineApiEndpoint<{
    params: ReportParams;
    query: { filename: string };
    body: Blob;
    data: ReportAttachment;
}>({
    method: 'POST',
    path: '/reports/:reportId/attachments',
    timeout: 90_000,
    inputValidators: {
        params: reportResourceParams,
        query: {
            parse: (value: { filename: string }) => ({
                filename: parseContract(ReportAttachmentFilenameSchema, value?.filename),
            }),
        },
        body: {
            parse(value: unknown) {
                if (
                    !(value instanceof Blob) ||
                    !value.size ||
                    value.size > REPORT_ATTACHMENT_MAX_BYTES ||
                    !Object.values<string>(REPORT_ATTACHMENT_MEDIA_TYPES).includes(value.type)
                )
                    throw new TypeError('请选择受支持的非空文件，大小不得超过 10 MiB');
                return value;
            },
        },
    },
    validator: modelValidator(ReportAttachmentSchema),
});

const rowsValidator = modelValidator(ReportAttachmentRowsSchema);
export const reportAttachmentRowsEndpoint = defineApiEndpoint<{
    params: AttachmentParams;
    query: RowRange;
    data: ReturnType<typeof rowsValidator.parse>;
}>({
    method: 'GET',
    path: '/reports/:reportId/attachments/:attachmentId/rows',
    inputValidators: { params: attachmentParams, query: { parse: (value: RowRange) => value } },
    validator: rowsValidator,
});

export const deleteReportAttachmentEndpoint = defineApiEndpoint<{
    params: AttachmentParams;
    data: { id: string };
}>({
    method: 'DELETE',
    path: '/reports/:reportId/attachments/:attachmentId',
    inputValidators: { params: attachmentParams },
    validator: modelValidator(ReportAttachmentDeletedSchema),
});

export const downloadReportAttachmentEndpoint = defineApiEndpoint<{
    params: AttachmentParams;
    data: Blob;
}>({
    method: 'GET',
    path: '/reports/:reportId/attachments/:attachmentId/download',
    timeout: 90_000,
    responseType: 'blob',
    inputValidators: { params: attachmentParams },
    validator: reportDownloadValidator('application/octet-stream', REPORT_ATTACHMENT_MAX_BYTES),
});
