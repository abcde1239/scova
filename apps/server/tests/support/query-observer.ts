import type pg from 'pg';
import { createDatabaseClient, type DatabaseClient } from '@scova/db';

type ObservedQuery = { text: string; values: readonly unknown[] };
type QueryHooks = {
    before?(query: ObservedQuery): void | Promise<void>;
    after?(query: ObservedQuery): void | Promise<void>;
};

/** Observe real driver queries, including transaction clients; never replace their results. */
export function createObservedDatabase(
    connectionString: string,
    hooks: QueryHooks,
): DatabaseClient {
    const db = createDatabaseClient({ connectionString });
    db.$client.on('connect', (client: pg.PoolClient) => {
        // pg has callback, promise and Submittable overloads. Drizzle uses the promise form;
        // other overloads retain their exact native behavior.
        const execute = client.query.bind(client) as (...args: unknown[]) => unknown;
        const query = (...args: unknown[]) => {
            if (typeof args.at(-1) === 'function') return execute(...args);
            const config = args[0];
            const text =
                typeof config === 'string'
                    ? config
                    : config && typeof config === 'object' && 'text' in config
                      ? String(config.text)
                      : undefined;
            if (text === undefined) return execute(...args);
            const observed = { text, values: Array.isArray(args[1]) ? args[1] : [] };
            return (async () => {
                await hooks.before?.(observed);
                const result = await execute(...args);
                await hooks.after?.(observed);
                return result;
            })();
        };
        client.query = query as typeof client.query;
    });
    return db;
}
