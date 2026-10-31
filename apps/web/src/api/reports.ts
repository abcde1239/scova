import { ReportSchema, UuidSchema, parseContract, type Report } from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export const reportEndpoint = defineApiEndpoint<{
    params: { reportId: string };
    data: Report;
}>({
    method: 'GET',
    path: '/reports/:reportId',
    inputValidators: {
        params: {
            parse(value: unknown) {
                const id =
                    value && typeof value === 'object' && 'reportId' in value
                        ? value.reportId
                        : undefined;
                return { reportId: parseContract(UuidSchema, id) };
            },
        },
    },
    validator: modelValidator(ReportSchema),
});
