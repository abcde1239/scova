import { pgTable, uuid, integer, jsonb, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { RunGraphState } from '@scova/models';
import { runs } from './runs.ts';

/** Bounded event projection, kept independently of the retained SSE event window. */
export const runGraphSnapshots = pgTable(
    'run_graph_snapshots',
    {
        runId: uuid('run_id').notNull().primaryKey(),
        userId: uuid('user_id').notNull(),
        seq: integer('seq').notNull(),
        stateJson: jsonb('state_json').$type<RunGraphState>().notNull(),
    },
    (table) => [
        foreignKey({
            name: 'run_graph_snapshots_user_id_run_id_fkey',
            columns: [table.userId, table.runId],
            foreignColumns: [runs.userId, runs.id],
        }).onDelete('cascade'),
        check('run_graph_snapshot_seq_valid', sql`${table.seq} >= 1`),
    ],
);
