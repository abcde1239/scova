import { createHash } from 'node:crypto';
import type { searchConfigurations } from './schema/identity.ts';

/** Exact account Search API configuration selected when a report follow-up was confirmed. */
export function reportSearchConfigurationHash(record: typeof searchConfigurations.$inferSelect) {
    return createHash('sha256')
        .update(
            JSON.stringify([
                'report-followup-search-v1',
                record.userId,
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
