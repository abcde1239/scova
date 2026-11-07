import {
    AgentProviderSchema,
    AgentProviderListSchema,
    AgentProviderInputSchema,
    AgentProviderUpdateSchema,
    AgentProviderRevisionSchema,
    AgentProviderActivationSchema,
    AgentModelCatalogInputSchema,
    AgentModelCatalogSchema,
    AgentProviderBalanceInputSchema,
    AgentProviderBalanceSchema,
    type AgentProviderBalanceInput,
    type AgentProviderBalance,
    type AgentModelCatalogInput,
    type AgentModelCatalog,
    type AgentProviderPurpose,
    UuidSchema,
    parseContract,
    type AgentProvider,
    type AgentProviderList,
    type AgentProviderInput,
    type AgentProviderUpdate,
} from '@scova/models';
import { defineApiEndpoint } from '@/api/endpoints';
import { modelValidator, voidValidator } from '@/api/validator';
const params = {
    parse: (value: unknown) => ({ id: parseContract(UuidSchema, (value as { id?: unknown })?.id) }),
};
export const providerBalanceEndpoint = defineApiEndpoint<{
    params: { id: string };
    body: AgentProviderBalanceInput;
    data: AgentProviderBalance;
}>({
    method: 'POST',
    path: '/me/agent-providers/:id/balance',
    inputValidators: { params, body: modelValidator(AgentProviderBalanceInputSchema) },
    validator: modelValidator(AgentProviderBalanceSchema),
});
export const providerModelsEndpoint = defineApiEndpoint<{
    body: AgentModelCatalogInput;
    data: AgentModelCatalog;
}>({
    method: 'POST',
    path: '/me/agent-providers/models',
    inputValidators: { body: modelValidator(AgentModelCatalogInputSchema) },
    validator: modelValidator(AgentModelCatalogSchema),
});
export const listProvidersEndpoint = defineApiEndpoint<{ data: AgentProviderList }>({
    method: 'GET',
    path: '/me/agent-providers',
    validator: modelValidator(AgentProviderListSchema),
});
export const createProviderEndpoint = defineApiEndpoint<{
    body: AgentProviderInput;
    data: AgentProvider;
}>({
    method: 'POST',
    path: '/me/agent-providers',
    inputValidators: { body: modelValidator(AgentProviderInputSchema) },
    validator: modelValidator(AgentProviderSchema),
});
export const updateProviderEndpoint = defineApiEndpoint<{
    params: { id: string };
    body: AgentProviderUpdate;
    data: AgentProvider;
}>({
    method: 'PATCH',
    path: '/me/agent-providers/:id',
    inputValidators: { body: modelValidator(AgentProviderUpdateSchema), params },
    validator: modelValidator(AgentProviderSchema),
});
export const activateProviderEndpoint = defineApiEndpoint<{
    params: { id: string };
    body: { revision: number; purpose?: AgentProviderPurpose };
    data: AgentProvider;
}>({
    method: 'POST',
    path: '/me/agent-providers/:id/activate',
    inputValidators: { body: modelValidator(AgentProviderActivationSchema), params },
    validator: modelValidator(AgentProviderSchema),
});
export const deleteProviderEndpoint = defineApiEndpoint<{
    params: { id: string };
    body: { revision: number };
    data: void;
}>({
    method: 'DELETE',
    path: '/me/agent-providers/:id',
    inputValidators: { body: modelValidator(AgentProviderRevisionSchema), params },
    validator: voidValidator,
});
