import { t } from 'elysia';
import { PROJECT_THREAD_ATTACHMENT_MAX_BYTES } from '@scova/models';

export const threadAttachmentReadsSchema = t.Array(
    t.Object(
        {
            attachmentId: t.String({ maxLength: 36 }),
            operation: t.Union([t.Literal('search'), t.Literal('read_lines')]),
            query: t.String({ maxLength: 120 }),
            startLine: t.Integer({ minimum: 1, maximum: PROJECT_THREAD_ATTACHMENT_MAX_BYTES }),
        },
        { additionalProperties: false },
    ),
    { maxItems: 3 },
);
