import { pgEnum } from 'drizzle-orm/pg-core';

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | { [key: string]: JsonValue }
    | JsonValue[];

export const taskStatusEnum = pgEnum('TaskStatus', ['active', 'paused', 'archived']);

export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];

export const occurrenceStatusEnum = pgEnum('OccurrenceStatus', [
    'created',
    'skipped_overlap',
    'missed',
    'paused',
]);

export type OccurrenceStatus = (typeof occurrenceStatusEnum.enumValues)[number];

export const serviceModeEnum = pgEnum('ServiceMode', ['demo', 'live']);

export type ServiceMode = (typeof serviceModeEnum.enumValues)[number];

export const runTriggerEnum = pgEnum('RunTrigger', ['manual', 'scheduled', 'retry', 'followup']);

export type RunTrigger = (typeof runTriggerEnum.enumValues)[number];

export const runStatusEnum = pgEnum('RunStatus', [
    'queued',
    'running',
    'recovering',
    'cancel_requested',
    'canceled',
    'succeeded',
    'partial',
    'failed',
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export const runOutcomeEnum = pgEnum('RunOutcome', [
    'baseline',
    'important_change',
    'new_findings',
    'no_important_change',
    'inconclusive',
]);

export type RunOutcome = (typeof runOutcomeEnum.enumValues)[number];

export const toolCallStatusEnum = pgEnum('ToolCallStatus', [
    'reserved',
    'running',
    'succeeded',
    'failed',
    'unknown',
]);

export type ToolCallStatus = (typeof toolCallStatusEnum.enumValues)[number];

export const idempotencyStatusEnum = pgEnum('IdempotencyStatus', ['pending', 'completed']);

export type IdempotencyStatus = (typeof idempotencyStatusEnum.enumValues)[number];

export const fetchStatusEnum = pgEnum('FetchStatus', ['succeeded', 'failed']);

export type FetchStatus = (typeof fetchStatusEnum.enumValues)[number];

export const outputFormatEnum = pgEnum('OutputFormat', [
    'brief',
    'list',
    'comparison',
    'research_report',
]);

export type OutputFormat = (typeof outputFormatEnum.enumValues)[number];

export const completenessEnum = pgEnum('Completeness', ['complete', 'partial']);

export type Completeness = (typeof completenessEnum.enumValues)[number];

export const claimKindEnum = pgEnum('ClaimKind', [
    'fact',
    'inference',
    'conflict',
    'insufficient',
    'model_answer',
]);

export type ClaimKind = (typeof claimKindEnum.enumValues)[number];

export const evidenceRelationEnum = pgEnum('EvidenceRelation', ['supports', 'contradicts']);

export type EvidenceRelation = (typeof evidenceRelationEnum.enumValues)[number];

export const changeKindEnum = pgEnum('ChangeKind', [
    'baseline',
    'new',
    'duplicate',
    'duplicate_candidate',
    'changed',
    'non_material',
    'uncertain',
]);

export type ChangeKind = (typeof changeKindEnum.enumValues)[number];

export const evidenceSideEnum = pgEnum('EvidenceSide', ['old', 'new']);

export type EvidenceSide = (typeof evidenceSideEnum.enumValues)[number];

export const notificationKindEnum = pgEnum('NotificationKind', [
    'summary',
    'important_change',
    'run_issue',
]);

export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];

export const feedbackKindEnum = pgEnum('FeedbackKind', ['irrelevant', 'known', 'deeper']);

export type FeedbackKind = (typeof feedbackKindEnum.enumValues)[number];
