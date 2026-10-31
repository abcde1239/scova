import {
    FeedbackInputSchema,
    FeedbackListSchema,
    FeedbackSchema,
    UuidSchema,
    parseContract,
    type Feedback,
    type FeedbackInput,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export const taskFeedbackEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    data: { items: Feedback[] };
}>({
    method: 'GET',
    path: '/tasks/:taskId/feedback',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const taskId =
                    value && typeof value === 'object' && 'taskId' in value
                        ? value.taskId
                        : undefined;
                return { taskId: parseContract(UuidSchema, taskId) };
            },
        },
    },
    validator: modelValidator(FeedbackListSchema),
});

export const setFeedbackEndpoint = defineApiEndpoint<{ body: FeedbackInput; data: Feedback }>({
    method: 'POST',
    path: '/feedback',
    inputValidators: { body: modelValidator(FeedbackInputSchema) },
    validator: modelValidator(FeedbackSchema),
});

export const revokeFeedbackEndpoint = defineApiEndpoint<{
    params: { feedbackId: string };
    data: Feedback;
}>({
    method: 'DELETE',
    path: '/feedback/:feedbackId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const feedbackId =
                    value && typeof value === 'object' && 'feedbackId' in value
                        ? value.feedbackId
                        : undefined;
                return { feedbackId: parseContract(UuidSchema, feedbackId) };
            },
        },
    },
    validator: modelValidator(FeedbackSchema),
});
