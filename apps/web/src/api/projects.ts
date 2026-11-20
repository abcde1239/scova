import {
    CreateProjectInputSchema,
    PageQuerySchema,
    ProjectDetailResponseSchema,
    ProjectListResponseSchema,
    ProjectSchema,
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
