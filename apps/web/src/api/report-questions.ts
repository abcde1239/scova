import {
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    UuidSchema,
    parseContract,
    type ReportQuestion,
    ReportConversationSchema,
    ReportConversationQuerySchema,
    type ReportConversation,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

const reportParams = {
    parse(value: unknown) {
        const params = value as Record<string, unknown> | undefined;
        return { reportId: parseContract(UuidSchema, params?.reportId) };
    },
};
export const createReportQuestionEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    body: { question: string; afterQuestionId?: string | null };
    data: ReportQuestion;
}>({
    method: 'POST',
    path: '/reports/:reportId/questions',
    inputValidators: { params: reportParams, body: modelValidator(ReportQuestionInputSchema) },
    validator: modelValidator(ReportQuestionSchema),
});
export const reportQuestionEndpoint = defineApiEndpoint<{
    params: { reportId: string; questionId: string };
    data: ReportQuestion;
}>({
    method: 'GET',
    path: '/reports/:reportId/questions/:questionId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const params = value as Record<string, unknown> | undefined;
                return {
                    ...reportParams.parse(value),
                    questionId: parseContract(UuidSchema, params?.questionId),
                };
            },
        },
    },
    validator: modelValidator(ReportQuestionSchema),
});

export const reportConversationEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    query: { beforeQuestionId?: string };
    data: ReportConversation;
}>({
    method: 'GET',
    path: '/reports/:reportId/conversation',
    inputValidators: { params: reportParams, query: modelValidator(ReportConversationQuerySchema) },
    validator: modelValidator(ReportConversationSchema),
});
