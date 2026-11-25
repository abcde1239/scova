import {
    PatchProjectSettingsSchema,
    ProjectSettingsSchema,
    UuidSchema,
    parseContract,
    type PatchProjectSettings,
    type ProjectSettings,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

type Params = { projectId: string };
const params = {
    parse(input: Params) {
        parseContract(UuidSchema, input.projectId);
        return input;
    },
};
const path = '/projects/:projectId/settings';

export const projectSettingsEndpoint = defineApiEndpoint<{ params: Params; data: ProjectSettings }>(
    {
        method: 'GET',
        path,
        inputValidators: { params },
        validator: modelValidator(ProjectSettingsSchema),
    },
);

export const patchProjectSettingsEndpoint = defineApiEndpoint<{
    params: Params;
    body: PatchProjectSettings;
    data: ProjectSettings;
}>({
    method: 'PATCH',
    path,
    inputValidators: { params, body: modelValidator(PatchProjectSettingsSchema) },
    validator: modelValidator(ProjectSettingsSchema),
});
