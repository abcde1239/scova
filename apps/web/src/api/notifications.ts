import {
    NotificationListQuerySchema,
    NotificationListResponseSchema,
    NotificationPatchInputSchema,
    NotificationSchema,
    UuidSchema,
    parseContract,
    type Notification,
    type NotificationListQuery,
    type NotificationPatchInput,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export type NotificationPage = typeof NotificationListResponseSchema.static;

export const notificationsEndpoint = defineApiEndpoint<{
    query: NotificationListQuery;
    data: NotificationPage;
}>({
    method: 'GET',
    path: '/notifications',
    inputValidators: { query: modelValidator(NotificationListQuerySchema) },
    validator: modelValidator(NotificationListResponseSchema),
});

export const notificationReadEndpoint = defineApiEndpoint<{
    params: { notificationId: string };
    body: NotificationPatchInput;
    data: Notification;
}>({
    method: 'PATCH',
    path: '/notifications/:notificationId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const candidate =
                    value && typeof value === 'object' && 'notificationId' in value
                        ? value.notificationId
                        : undefined;
                return { notificationId: parseContract(UuidSchema, candidate) };
            },
        },
        body: modelValidator(NotificationPatchInputSchema),
    },
    validator: modelValidator(NotificationSchema),
});
