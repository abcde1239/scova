import {
    CreateProjectInputSchema,
    CreateProjectTaskInputSchema,
    CreateProjectTaskResponseSchema,
    ProjectConversationSchema,
    ProjectConversationInputSchema,
    ProjectDraftEditSchema,
    ProjectDraftConfirmSchema,
    ProjectResearchDraftSchema,
    type ProjectConversation,
    type ProjectConversationInput,
    type ProjectDraftEdit,
    type ProjectDraftConfirm,
    type ProjectResearchDraft,
    type CreateProjectTaskInput,
    type CreateProjectTaskResponse,
    PageQuerySchema,
    ProjectDetailResponseSchema,
    ProjectListResponseSchema,
    ProjectSchema,
    TaskProjectResponseSchema,
    type TaskProjectResponse,
    UuidSchema,
    parseContract,
    type CreateProjectInput,
    type PageQuery,
    type Project,
    type ProjectDetailResponse,
    type ProjectListResponse,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator, voidValidator } from '@/api/validator';

export const projectsEndpoint = defineApiEndpoint<{ query: PageQuery; data: ProjectListResponse }>({
    method: 'GET',
    path: '/projects',
    inputValidators: { query: modelValidator(PageQuerySchema) },
    validator: modelValidator(ProjectListResponseSchema),
});

export const createProjectEndpoint = defineApiEndpoint<{ body: CreateProjectInput; data: Project }>(
    {
        method: 'POST',
        path: '/projects',
        inputValidators: { body: modelValidator(CreateProjectInputSchema) },
        validator: modelValidator(ProjectSchema),
    },
);

type ProjectParams = { projectId: string };
type MembershipParams = ProjectParams & { taskId: string };
const projectParams = {
    parse(value: ProjectParams) {
        return { projectId: parseContract(UuidSchema, value?.projectId) };
    },
};
const membershipParams = {
    parse(value: MembershipParams) {
        return { ...projectParams.parse(value), taskId: parseContract(UuidSchema, value?.taskId) };
    },
};

const taskParams = {
    parse(value: { taskId: string }) {
        return { taskId: parseContract(UuidSchema, value?.taskId) };
    },
};
export const taskProjectEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    data: TaskProjectResponse;
}>({
    method: 'GET',
    path: '/tasks/:taskId/project',
    inputValidators: { params: taskParams },
    validator: modelValidator(TaskProjectResponseSchema),
});
export const createTaskProjectEndpoint = defineApiEndpoint<{
    params: { taskId: string };
    body: CreateProjectInput;
    data: Project;
}>({
    method: 'POST',
    path: '/tasks/:taskId/project',
    inputValidators: { params: taskParams, body: modelValidator(CreateProjectInputSchema) },
    validator: modelValidator(ProjectSchema),
});

export const projectEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    query: PageQuery;
    data: ProjectDetailResponse;
}>({
    method: 'GET',
    path: '/projects/:projectId',
    inputValidators: { params: projectParams, query: modelValidator(PageQuerySchema) },
    validator: modelValidator(ProjectDetailResponseSchema),
});

export const createProjectTaskEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    body: CreateProjectTaskInput;
    data: CreateProjectTaskResponse;
}>({
    method: 'POST',
    path: '/projects/:projectId/tasks',
    inputValidators: { params: projectParams, body: modelValidator(CreateProjectTaskInputSchema) },
    validator: modelValidator(CreateProjectTaskResponseSchema),
});

export const deleteProjectEndpoint = defineApiEndpoint<{ params: ProjectParams; data: void }>({
    method: 'DELETE',
    path: '/projects/:projectId',
    inputValidators: { params: projectParams },
    validator: voidValidator,
});

export const assignProjectTaskEndpoint = defineApiEndpoint<{
    params: MembershipParams;
    data: void;
}>({
    method: 'PUT',
    path: '/projects/:projectId/tasks/:taskId',
    inputValidators: { params: membershipParams },
    validator: voidValidator,
});

export const unlinkProjectTaskEndpoint = defineApiEndpoint<{
    params: MembershipParams;
    data: void;
}>({
    method: 'DELETE',
    path: '/projects/:projectId/tasks/:taskId',
    inputValidators: { params: membershipParams },
    validator: voidValidator,
});

type TurnParams = ProjectParams & { turnId: string };
type DraftParams = ProjectParams & { draftId: string };
const draftParams = {
    parse(value: DraftParams) {
        return {
            ...projectParams.parse(value),
            draftId: parseContract(UuidSchema, value?.draftId),
        };
    },
};
const turnParams = {
    parse(value: TurnParams) {
        return { ...projectParams.parse(value), turnId: parseContract(UuidSchema, value?.turnId) };
    },
};
export const projectConversationEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    data: ProjectConversation;
}>({
    method: 'GET',
    path: '/projects/:projectId/conversation',
    inputValidators: { params: projectParams },
    validator: modelValidator(ProjectConversationSchema),
});
export const sendProjectTurnEndpoint = defineApiEndpoint<{
    params: ProjectParams;
    body: ProjectConversationInput;
    data: ProjectConversation;
}>({
    method: 'POST',
    path: '/projects/:projectId/conversation/turns',
    inputValidators: {
        params: projectParams,
        body: modelValidator(ProjectConversationInputSchema),
    },
    validator: modelValidator(ProjectConversationSchema),
});
export const cancelProjectTurnEndpoint = defineApiEndpoint<{
    params: TurnParams;
    data: ProjectConversation;
}>({
    method: 'POST',
    path: '/projects/:projectId/conversation/turns/:turnId/cancel',
    inputValidators: { params: turnParams },
    validator: modelValidator(ProjectConversationSchema),
});
export const editProjectDraftEndpoint = defineApiEndpoint<{
    params: DraftParams;
    body: ProjectDraftEdit;
    data: ProjectResearchDraft;
}>({
    method: 'PATCH',
    path: '/projects/:projectId/drafts/:draftId',
    inputValidators: { params: draftParams, body: modelValidator(ProjectDraftEditSchema) },
    validator: modelValidator(ProjectResearchDraftSchema),
});
export const confirmProjectDraftEndpoint = defineApiEndpoint<{
    params: DraftParams;
    body: ProjectDraftConfirm;
    data: CreateProjectTaskResponse;
}>({
    method: 'POST',
    path: '/projects/:projectId/drafts/:draftId/confirm',
    inputValidators: { params: draftParams, body: modelValidator(ProjectDraftConfirmSchema) },
    validator: modelValidator(CreateProjectTaskResponseSchema),
});
