import { createHash } from 'node:crypto';
import { runs, toolCalls, eq, type DatabaseClient, type searchConfigurations } from '@scova/db';
import { withRunFence } from './runs.ts';
import { RunExecutionError, type RunLeaseToken } from '@scova/shared/execution/runs';

/** Only a hash reaches the Run. Credentials stay encrypted in their account record. */
export function customConfigurationHash(
    record: typeof searchConfigurations.$inferSelect | null,
    selected: 'api' | 'searxng',
): string | null {
    if (selected !== 'api' || record?.protocol !== 'custom_json') return null;
    return createHash('sha256')
        .update(
            JSON.stringify([
                record.id,
                record.revision,
                record.protocol,
                record.baseUrl,
                record.contentMode,
                record.customTemplate,
                record.encryptedApiKey,
            ]),
        )
        .digest('hex');
}

export function freezeSearchConfiguration(
    database: DatabaseClient,
    token: RunLeaseToken,
    hash: string | null,
    confirmed = false,
): Promise<void> {
    return withRunFence(database, token, 'work', async (tx, run) => {
        if (confirmed) {
            if (!hash || hash !== run.searchConfigurationHash)
                throw new RunExecutionError('SEARCH_CONFIGURATION_CHANGED');
            return;
        }
        if (run.searchConfigurationHash) {
            if (hash !== run.searchConfigurationHash)
                throw new RunExecutionError('SEARCH_CONFIGURATION_CHANGED');
        } else if (hash) {
            // Never silently adopt a new custom provider for an old persisted execution.
            if (run.checkpointRef) throw new RunExecutionError('SEARCH_CONFIGURATION_CHANGED');
            const previous = await tx
                .select({ id: toolCalls.id })
                .from(toolCalls)
                .where(eq(toolCalls.runId, run.id))
                .limit(1);
            if (previous.length) throw new RunExecutionError('SEARCH_CONFIGURATION_CHANGED');
            await tx.update(runs).set({ searchConfigurationHash: hash }).where(eq(runs.id, run.id));
        }
    });
}
