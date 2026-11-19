import {
    ReportQuestionInputSchema,
    ReportQuestionSchema,
    ReportQuestionDetailSchema,
    ReportFollowupInputSchema,
    ReportFollowupResponseSchema,
    type ReportFollowupInput,
    UuidSchema,
    parseContract,
    type ReportQuestion,
    ReportConversationSchema,
    ReportConversationQuerySchema,
    type ReportConversation,
    ReportMergeInputSchema,
    RunCommandResponseSchema,
    type OutputFormat,
    type RunCommandResponse,
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
export type ReportQuestionDetail = ReturnType<
    typeof parseContract<typeof ReportQuestionDetailSchema>
>;
export const requestReportFollowupEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    body: ReportFollowupInput;
    data: ReturnType<typeof parseContract<typeof ReportFollowupResponseSchema>>;
}>({
    method: 'POST',
    path: '/reports/:reportId/followup',
    inputValidators: { params: reportParams, body: modelValidator(ReportFollowupInputSchema) },
    validator: modelValidator(ReportFollowupResponseSchema),
});

export const reportQuestionEndpoint = defineApiEndpoint<{
    params: { reportId: string; questionId: string };
    data: ReportQuestionDetail;
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
    validator: modelValidator(ReportQuestionDetailSchema),
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

export const mergeReportEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    body: { confirm: true; reportIds: string[]; outputFormats?: OutputFormat[] };
    data: RunCommandResponse;
}>({
    method: 'POST',
    path: '/reports/:reportId/merge',
    inputValidators: { params: reportParams, body: modelValidator(ReportMergeInputSchema) },
    validator: modelValidator(RunCommandResponseSchema),
});
