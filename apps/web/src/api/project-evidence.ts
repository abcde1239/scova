import {
    ProjectReportEvidenceSchema,
    UuidSchema,
    parseContract,
    type ProjectReportEvidence,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

type Params = { projectId: string; reportId: string };

export const projectReportEvidenceEndpoint = defineApiEndpoint<{
    params: Params;
    data: ProjectReportEvidence;
}>({
    method: 'GET',
    path: '/projects/:projectId/evidence/reports/:reportId',
    inputValidators: {
        params: {
            parse(value: Params) {
                return {
                    projectId: parseContract(UuidSchema, value?.projectId),
                    reportId: parseContract(UuidSchema, value?.reportId),
                };
            },
        },
    },
    validator: modelValidator(ProjectReportEvidenceSchema),
});
