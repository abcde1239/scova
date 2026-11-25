import {
    WorkspaceHomeSchema,
    WorkspaceIntakeInputSchema,
    WorkspaceIntakeResultSchema,
    type WorkspaceHome,
    type WorkspaceIntakeInput,
    type WorkspaceIntakeResult,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export const workspaceHomeEndpoint = defineApiEndpoint<{ data: WorkspaceHome }>({
    method: 'GET',
    path: '/workspace/home',
    validator: modelValidator(WorkspaceHomeSchema),
});

export const workspaceIntakeEndpoint = defineApiEndpoint<{
    body: WorkspaceIntakeInput;
    data: WorkspaceIntakeResult;
}>({
    method: 'POST',
    path: '/workspace/intake',
    inputValidators: { body: modelValidator(WorkspaceIntakeInputSchema) },
    validator: modelValidator(WorkspaceIntakeResultSchema),
});
