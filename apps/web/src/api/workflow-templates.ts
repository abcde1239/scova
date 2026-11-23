import {
    UuidSchema,
    WorkflowDetailSchema,
    WorkflowStartResponseSchema,
    WorkflowTemplateListSchema,
    WorkflowTemplateSaveSchema,
    WorkflowTemplateSchema,
    WorkflowTemplateStartSchema,
    parseContract,
    type WorkflowTemplate,
    type WorkflowTemplateSave,
    type WorkflowTemplateStart,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';
import type { WorkflowDetail } from '@/api/workflows';

export type WorkflowTemplateParams = { templateId: string; templateVersion: string };

const params = {
    parse(value: unknown): WorkflowTemplateParams {
        const input = value as Partial<WorkflowTemplateParams> | undefined;
        const templateId = parseContract(UuidSchema, input?.templateId);
        const templateVersion = input?.templateVersion;
        if (!templateVersion || !/^[1-9]\d*$/u.test(templateVersion))
            throw new TypeError('模板版本无效');
        return { templateId, templateVersion };
    },
};
const base = '/workflow-templates';
const version = `${base}/:templateId/versions/:templateVersion`;

export const workflowTemplatesEndpoint = defineApiEndpoint<{
    data: typeof WorkflowTemplateListSchema.static;
}>({ method: 'GET', path: base, validator: modelValidator(WorkflowTemplateListSchema) });

export const saveWorkflowTemplateEndpoint = defineApiEndpoint<{
    body: WorkflowTemplateSave;
    data: WorkflowTemplate;
}>({
    method: 'POST',
    path: base,
    inputValidators: { body: modelValidator(WorkflowTemplateSaveSchema) },
    validator: modelValidator(WorkflowTemplateSchema),
});

export const copyWorkflowTemplateEndpoint = defineApiEndpoint<{
    params: WorkflowTemplateParams;
    data: WorkflowDetail;
}>({
    method: 'POST',
    path: `${version}/copy`,
    inputValidators: { params },
    validator: modelValidator(WorkflowDetailSchema),
});

export const startWorkflowTemplateEndpoint = defineApiEndpoint<{
    params: WorkflowTemplateParams;
    body: WorkflowTemplateStart;
    data: typeof WorkflowStartResponseSchema.static;
}>({
    method: 'POST',
    path: `${version}/start`,
    inputValidators: { params, body: modelValidator(WorkflowTemplateStartSchema) },
    validator: modelValidator(WorkflowStartResponseSchema),
});
