import {
    SearchConfigurationSchema,
    SearchConfigurationResultSchema,
    SearchConfigurationInputSchema,
    SearchConfigurationImportSchema,
    UuidSchema,
    parseContract,
    type SearchConfiguration,
    type SearchConfigurationResult,
    type SearchConfigurationInput,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator } from '@/api/validator';

export const searchConfigurationEndpoint = defineApiEndpoint<{ data: SearchConfigurationResult }>({
    method: 'GET',
    path: '/me/search-configuration',
    validator: modelValidator(SearchConfigurationResultSchema),
});
export const saveSearchConfigurationEndpoint = defineApiEndpoint<{
    body: SearchConfigurationInput;
    data: SearchConfiguration;
}>({
    method: 'PUT',
    path: '/me/search-configuration',
    inputValidators: { body: modelValidator(SearchConfigurationInputSchema) },
    validator: modelValidator(SearchConfigurationSchema),
});
export const importSearchConfigurationEndpoint = defineApiEndpoint<{
    params: { providerId: string };
    body: { revision?: number; providerRevision: number };
    data: SearchConfiguration;
}>({
    method: 'POST',
    path: '/me/search-configuration/import/:providerId',
    inputValidators: {
        params: {
            parse: (value: unknown) => ({
                providerId: parseContract(
                    UuidSchema,
                    (value as { providerId?: unknown })?.providerId,
                ),
            }),
        },
        body: modelValidator(SearchConfigurationImportSchema),
    },
    validator: modelValidator(SearchConfigurationSchema),
});
