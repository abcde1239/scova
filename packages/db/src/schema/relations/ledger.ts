import { relations } from 'drizzle-orm';
import { toolCalls, runEvents, outbox, idempotencyRecords } from '../ledger.ts';
import { users } from '../identity.ts';
import { runs } from '../runs.ts';

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_ToolCall',
        fields: [toolCalls.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'ToolCall_run',
        fields: [toolCalls.userId, toolCalls.runId],
        references: [runs.userId, runs.id],
    }),
}));

export const runEventsRelations = relations(runEvents, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_RunEvent',
        fields: [runEvents.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'RunEvent_run',
        fields: [runEvents.userId, runEvents.runId],
        references: [runs.userId, runs.id],
    }),
}));

export const outboxRelations = relations(outbox, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_Outbox',
        fields: [outbox.userId],
        references: [users.id],
    }),
    run: one(runs, {
        relationName: 'Outbox_run',
        fields: [outbox.userId, outbox.aggregateId],
        references: [runs.userId, runs.id],
    }),
}));

export const idempotencyRecordsRelations = relations(idempotencyRecords, ({ one }) => ({
    owner: one(users, {
        relationName: 'User_IdempotencyRecord',
        fields: [idempotencyRecords.userId],
        references: [users.id],
    }),
}));
