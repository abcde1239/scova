import {
    InboxItemSchema,
    InboxListQuerySchema,
    InboxListResponseSchema,
    InboxPatchInputSchema,
    UuidSchema,
    parseContract,
    type InboxListQuery,
    type InboxPatchInput,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export type InboxItem = typeof InboxItemSchema.static;
export type InboxPage = typeof InboxListResponseSchema.static;

export const inboxEndpoint = defineApiEndpoint<{ query: InboxListQuery; data: InboxPage }>({
    method: 'GET',
    path: '/inbox',
    inputValidators: { query: modelValidator(InboxListQuerySchema) },
    validator: modelValidator(InboxListResponseSchema),
});

export const inboxReadEndpoint = defineApiEndpoint<{
    params: { inboxId: string };
    body: InboxPatchInput;
    data: InboxItem;
}>({
    method: 'PATCH',
    path: '/inbox/:inboxId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const id =
                    value && typeof value === 'object' && 'inboxId' in value
                        ? value.inboxId
                        : undefined;
                return { inboxId: parseContract(UuidSchema, id) };
            },
        },
        body: modelValidator(InboxPatchInputSchema),
    },
    validator: modelValidator(InboxItemSchema),
});
