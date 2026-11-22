import type { DatabaseClient } from '@scova/db';
import { reportSearchConfigurationHash } from '@scova/db';
import { openProviderCredentials } from '@scova/shared/credentials';
import type { ExecutionCredentials } from '@scova/shared/execution/protocol';
import { RunExecutionError, RunFenceError, type RunLeaseToken } from '@scova/shared/execution/runs';
import { TaskConfigSchema, ReportConversationContextSchema, parseContract } from '@scova/models';
import { activeAgentProvider } from '../../repo/execution/agent-providers.ts';
import { accountSearchConfiguration } from '../../repo/execution/search-configuration.ts';
import {
    customConfigurationHash,
    freezeSearchConfiguration,
} from '../../repo/execution/search-configuration-freeze.ts';
import { withRunFence } from '../../repo/execution/runs.ts';
import { accountSearchConfig, SearchConfigurationError } from './search-config.ts';

export async function executionCredentials(
    database: DatabaseClient,
    token: RunLeaseToken,
    env: NodeJS.ProcessEnv,
    confirmationOnly = false,
): Promise<ExecutionCredentials | undefined> {
    const { mode, config, conversation } = await withRunFence(
        database,
        token,
        'work',
        async (tx, run) => {
            const version = await tx.query.taskVersions.findFirst({
                where: (versions, { eq }) => eq(versions.id, run.taskVersionId),
            });
            if (!version || version.userId !== run.userId || version.taskId !== run.taskId)
                throw new RunExecutionError('INVALID_RUN_CONFIGURATION');
            return {
                mode: run.mode,
                config: parseContract(
                    TaskConfigSchema,
                    run.followupConfigJson ?? version.configJson,
                ),
                conversation: run.conversationContextJson
                    ? parseContract(ReportConversationContextSchema, run.conversationContextJson)
                    : undefined,
            };
        },
    );
    const selection = conversation?.searchSelection;
    if (
        selection &&
        (conversation.operation !== 'research' || selection.searchMode !== config.searchMode)
    )
        throw new RunExecutionError('INVALID_RUN_CONFIGURATION');
    const confirmedAccount =
        selection?.searchMode === 'api'
            ? await accountSearchConfiguration(database, token.userId)
            : null;
    const confirmedHash =
        confirmedAccount &&
        selection?.searchMode === 'api' &&
        confirmedAccount.revision === selection.searchConfigRevision
            ? reportSearchConfigurationHash(confirmedAccount)
            : null;
    if (selection?.searchMode === 'api')
        await freezeSearchConfiguration(database, token, confirmedHash, true);
    if (confirmationOnly) return;
    if (mode !== 'live') throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
    try {
        const own = await activeAgentProvider(database, token.userId, config.agentProviderId);
        if (config.agentProviderId && !own)
            throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
        const modelApiKey = own
            ? openProviderCredentials(
                  own.encryptedApiKey,
                  token.userId,
                  own.id,
                  env.AGENT_CREDENTIAL_KEY,
              ).modelApiKey
            : env.MODEL_API_KEY;
        const savedSearch =
            config.searchMode === 'searxng'
                ? null
                : selection
                  ? confirmedAccount
                  : await accountSearchConfiguration(database, token.userId);
        const searchConfig = accountSearchConfig(env, savedSearch, token.userId, config.searchMode);
        const frozenHash = selection
            ? confirmedHash
            : customConfigurationHash(savedSearch, searchConfig.searchProvider);
        if (!selection) await freezeSearchConfiguration(database, token, frozenHash);
        await withRunFence(database, token, 'work', async () => undefined);
        return {
            modelApiKey,
            model: own?.model ?? env.MODEL_NAME,
            modelBaseUrl: own?.baseUrl ?? env.MODEL_BASE_URL,
            modelProtocol: own?.protocol,
            ...searchConfig,
            searchIdentity: frozenHash ?? undefined,
        };
    } catch (error) {
        if (error instanceof RunExecutionError || error instanceof RunFenceError) throw error;
        if (error instanceof SearchConfigurationError)
            throw new RunExecutionError(error.failureCode);
        throw new RunExecutionError('AGENT_CONFIGURATION_INVALID');
    }
}
