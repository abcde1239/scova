import {
    PageQuerySchema,
    parseContract,
    UuidSchema,
    WorkflowDetailSchema,
    WorkflowDraftInputSchema,
    WorkflowListSchema,
    WorkflowRunListSchema,
    WorkflowRunSchema,
    WorkflowStartInputSchema,
    WorkflowStartResponseSchema,
    WorkflowVersionListSchema,
    WorkflowVersionSchema,
    type PageQuery,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export type WorkflowDetail = typeof WorkflowDetailSchema.static;
export type WorkflowDraft = typeof WorkflowDraftInputSchema.static;
export type WorkflowStart = typeof WorkflowStartInputSchema.static;

type WorkflowParams = { workflowId: string };
type WorkflowRunParams = { runId: string };

function uuidParam(input: unknown, key: string) {
    const value = input && typeof input === 'object' ? Reflect.get(input, key) : undefined;
    return parseContract(UuidSchema, value);
}

const workflowParams = {
    parse: (input: unknown) => ({ workflowId: uuidParam(input, 'workflowId') }),
};
const runParams = { parse: (input: unknown) => ({ runId: uuidParam(input, 'runId') }) };
export const workflowsEndpoint = defineApiEndpoint<{
    query: PageQuery;
    data: typeof WorkflowListSchema.static;
}>({
    method: 'GET',
    path: '/workflows',
    inputValidators: { query: modelValidator(PageQuerySchema) },
    validator: modelValidator(WorkflowListSchema),
});

export const workflowEndpoint = defineApiEndpoint<{ params: WorkflowParams; data: WorkflowDetail }>(
    {
        method: 'GET',
        path: '/workflows/:workflowId',
        inputValidators: { params: workflowParams },
        validator: modelValidator(WorkflowDetailSchema),
    },
);

export const createWorkflowEndpoint = defineApiEndpoint<{
    body: WorkflowDraft;
    data: WorkflowDetail;
}>({
    method: 'POST',
    path: '/workflows',
    inputValidators: { body: modelValidator(WorkflowDraftInputSchema) },
    validator: modelValidator(WorkflowDetailSchema),
});

export const updateWorkflowDraftEndpoint = defineApiEndpoint<{
    params: WorkflowParams;
    body: WorkflowDraft;
    data: WorkflowDetail;
}>({
    method: 'PATCH',
    path: '/workflows/:workflowId/draft',
    inputValidators: { params: workflowParams, body: modelValidator(WorkflowDraftInputSchema) },
    validator: modelValidator(WorkflowDetailSchema),
});

export const publishWorkflowEndpoint = defineApiEndpoint<{
    params: WorkflowParams;
    data: WorkflowDetail;
}>({
    method: 'POST',
    path: '/workflows/:workflowId/publish',
    inputValidators: { params: workflowParams },
    validator: modelValidator(WorkflowDetailSchema),
});

export const workflowRunsEndpoint = defineApiEndpoint<{
    params: WorkflowParams;
    query: PageQuery;
    data: typeof WorkflowRunListSchema.static;
}>({
    method: 'GET',
    path: '/workflows/:workflowId/runs',
    inputValidators: { params: workflowParams, query: modelValidator(PageQuerySchema) },
    validator: modelValidator(WorkflowRunListSchema),
});

export const startWorkflowEndpoint = defineApiEndpoint<{
    params: WorkflowParams;
    body: WorkflowStart;
    data: typeof WorkflowStartResponseSchema.static;
}>({
    method: 'POST',
    path: '/workflows/:workflowId/runs',
    inputValidators: { params: workflowParams, body: modelValidator(WorkflowStartInputSchema) },
    validator: modelValidator(WorkflowStartResponseSchema),
});

export const workflowRunEndpoint = defineApiEndpoint<{
    params: WorkflowRunParams;
    data: typeof WorkflowRunSchema.static;
}>({
    method: 'GET',
    path: '/workflow-runs/:runId',
    inputValidators: { params: runParams },
    validator: modelValidator(WorkflowRunSchema),
});

export const cancelWorkflowRunEndpoint = defineApiEndpoint<{
    params: WorkflowRunParams;
    data: typeof WorkflowRunSchema.static;
}>({
    method: 'POST',
    path: '/workflow-runs/:runId/cancel',
    inputValidators: { params: runParams },
    validator: modelValidator(WorkflowRunSchema),
});

export const workflowVersionsEndpoint = defineApiEndpoint<{
    params: WorkflowParams;
    query: PageQuery;
    data: typeof WorkflowVersionListSchema.static;
}>({
    method: 'GET',
    path: '/workflows/:workflowId/versions',
    inputValidators: { params: workflowParams, query: modelValidator(PageQuerySchema) },
    validator: modelValidator(WorkflowVersionListSchema),
});

export const workflowVersionEndpoint = defineApiEndpoint<{
    params: WorkflowParams & { versionId: string };
    data: typeof WorkflowVersionSchema.static;
}>({
    method: 'GET',
    path: '/workflows/:workflowId/versions/:versionId',
    inputValidators: {
        params: {
            parse: (input) => ({
                ...workflowParams.parse(input),
                versionId: uuidParam(input, 'versionId'),
            }),
        },
    },
    validator: modelValidator(WorkflowVersionSchema),
});
