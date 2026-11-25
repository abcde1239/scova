import {
    PROJECT_THREAD_ATTACHMENT_MAX_BYTES,
    REPORT_ATTACHMENT_MEDIA_TYPES,
    ProjectThreadAttachmentSchema,
    ReportAttachmentFilenameSchema,
    UuidSchema,
    parseContract,
    reportAttachmentFormat,
    type ProjectThreadAttachment,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { reportDownloadValidator } from '@/api/report-charts';
import { modelValidator } from '@/api/validator';

type ThreadParams = { threadId: string };
type AttachmentParams = ThreadParams & { attachmentId: string };
const threadParams = {
    parse(value: ThreadParams) {
        return { threadId: parseContract(UuidSchema, value?.threadId) };
    },
};
const attachmentParams = {
    parse(value: AttachmentParams) {
        return {
            ...threadParams.parse(value),
            attachmentId: parseContract(UuidSchema, value?.attachmentId),
        };
    },
};

export function threadAttachmentFile(file: File) {
    const filename = file.name.normalize('NFC').trim();
    const format = reportAttachmentFormat(filename);
    if (!format || !file.size || file.size > PROJECT_THREAD_ATTACHMENT_MAX_BYTES)
        throw new TypeError('请选择不超过 256 KiB 的非空 CSV、TXT 或 PDF 文件');
    return {
        query: { filename },
        body: file.slice(0, file.size, REPORT_ATTACHMENT_MEDIA_TYPES[format]),
    };
}

export const uploadThreadAttachmentEndpoint = defineApiEndpoint<{
    params: ThreadParams;
    query: { filename: string };
    body: Blob;
    data: ProjectThreadAttachment;
}>({
    method: 'POST',
    path: '/threads/:threadId/attachments',
    inputValidators: {
        params: threadParams,
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
                    value.size > PROJECT_THREAD_ATTACHMENT_MAX_BYTES ||
                    !Object.values<string>(REPORT_ATTACHMENT_MEDIA_TYPES).includes(value.type)
                )
                    throw new TypeError('请选择不超过 256 KiB 的非空 CSV、TXT 或 PDF 文件');
                return value;
            },
        },
    },
    validator: modelValidator(ProjectThreadAttachmentSchema),
});

export const threadAttachmentEndpoint = defineApiEndpoint<{
    params: AttachmentParams;
    data: ProjectThreadAttachment;
}>({
    method: 'GET',
    path: '/threads/:threadId/attachments/:attachmentId',
    inputValidators: { params: attachmentParams },
    validator: modelValidator(ProjectThreadAttachmentSchema),
});

export const downloadThreadAttachmentEndpoint = defineApiEndpoint<{
    params: AttachmentParams;
    data: Blob;
}>({
    method: 'GET',
    path: '/threads/:threadId/attachments/:attachmentId/download',
    responseType: 'blob',
    inputValidators: { params: attachmentParams },
    validator: reportDownloadValidator(
        'application/octet-stream',
        PROJECT_THREAD_ATTACHMENT_MAX_BYTES,
    ),
});
