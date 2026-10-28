-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('created', 'skipped_overlap', 'missed', 'paused');

-- CreateEnum
CREATE TYPE "ServiceMode" AS ENUM ('demo', 'live');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('manual', 'scheduled', 'retry', 'followup');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'recovering', 'cancel_requested', 'canceled', 'succeeded', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('baseline', 'important_change', 'new_findings', 'no_important_change', 'inconclusive');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('reserved', 'running', 'succeeded', 'failed', 'unknown');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('pending', 'completed');

-- CreateEnum
CREATE TYPE "FetchStatus" AS ENUM ('succeeded', 'failed');

-- CreateEnum
CREATE TYPE "OutputFormat" AS ENUM ('brief', 'list', 'comparison', 'research_report');

-- CreateEnum
CREATE TYPE "Completeness" AS ENUM ('complete', 'partial');

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('fact', 'inference', 'conflict', 'insufficient');

-- CreateEnum
CREATE TYPE "EvidenceRelation" AS ENUM ('supports', 'contradicts');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('baseline', 'new', 'duplicate', 'duplicate_candidate', 'changed', 'non_material', 'uncertain');

-- CreateEnum
CREATE TYPE "EvidenceSide" AS ENUM ('old', 'new');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('summary', 'important_change', 'run_issue');

-- CreateEnum
CREATE TYPE "FeedbackKind" AS ENUM ('irrelevant', 'known', 'deeper');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "default_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "notification_preference" JSONB NOT NULL DEFAULT '{"mode":"summary","runIssues":true}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "current_version_id" UUID,
    "schedule_revision" INTEGER NOT NULL DEFAULT 1,
    "next_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_versions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "input_text" TEXT,
    "config_schema_version" INTEGER NOT NULL DEFAULT 1,
    "config_json" JSONB NOT NULL,
    "comparison_scope_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_occurrences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'created',
    "run_id" UUID,
    "missed_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "schedule_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baselines" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "comparison_scope_hash" CHAR(64) NOT NULL,
    "complete_run_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "task_version_id" UUID NOT NULL,
    "comparison_scope_hash" CHAR(64) NOT NULL,
    "mode" "ServiceMode" NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "occurrence_id" UUID,
    "parent_run_id" UUID,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "deadline_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "lease_owner" TEXT,
    "lease_epoch" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TIMESTAMPTZ(6),
    "baseline_run_id" UUID,
    "feedback_snapshot_json" JSONB NOT NULL DEFAULT '[]',
    "budget_json" JSONB NOT NULL,
    "usage_json" JSONB NOT NULL DEFAULT '{}',
    "coverage_json" JSONB,
    "outcome" "RunOutcome",
    "failure_code" TEXT,
    "checkpoint_ref" JSONB,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "operation_key" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'reserved',
    "input_summary" TEXT NOT NULL,
    "reserved_budget" JSONB NOT NULL,
    "usage" JSONB,
    "output_ref" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL DEFAULT 'run',
    "aggregate_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'pending',
    "response_code" INTEGER,
    "resource_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "canonical_url_hash" CHAR(64) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "extractor_version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "text_body" TEXT,
    "text_expires_at" TIMESTAMPTZ(6),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_sources" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "snapshot_id" UUID,
    "requested_url" TEXT NOT NULL,
    "fetched_url" TEXT,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetch_status" "FetchStatus" NOT NULL,
    "error_code" TEXT,
    "relevance" DOUBLE PRECISION,

    CONSTRAINT "run_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "quote" TEXT NOT NULL,
    "selector_json" JSONB NOT NULL,
    "quote_hash" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "task_version_id" UUID NOT NULL,
    "baseline_run_id" UUID,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "format" "OutputFormat" NOT NULL,
    "completeness" "Completeness" NOT NULL,
    "limitations_json" JSONB NOT NULL DEFAULT '[]',
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "kind" "ClaimKind" NOT NULL,
    "text" TEXT NOT NULL,
    "confidence_label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "relation" "EvidenceRelation" NOT NULL,

    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "kind" "ChangeKind" NOT NULL,
    "old_source_id" UUID,
    "old_snapshot_id" UUID,
    "new_snapshot_id" UUID,
    "fact_key" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "importance" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "change_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "change_record_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "side" "EvidenceSide" NOT NULL,

    CONSTRAINT "change_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbox_items" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "report_id" UUID,
    "kind" "NotificationKind" NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "source_id" UUID,
    "claim_id" UUID,
    "kind" "FeedbackKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID,
    "report_id" UUID,
    "body" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_questions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer_json" JSONB,
    "followup_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,

    CONSTRAINT "question_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users"("normalized_email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_user_id_id_key" ON "sessions"("user_id", "id");

-- CreateIndex
CREATE INDEX "tasks_user_id_status_updated_at_idx" ON "tasks"("user_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_user_id_id_key" ON "tasks"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_versions_user_id_id_key" ON "task_versions"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_versions_user_id_task_id_version_key" ON "task_versions"("user_id", "task_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "task_versions_user_id_task_id_id_key" ON "task_versions"("user_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_occurrences_user_id_id_key" ON "schedule_occurrences"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_occurrences_task_id_schedule_revision_scheduled_at_key" ON "schedule_occurrences"("task_id", "schedule_revision", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_occurrences_user_id_task_id_id_key" ON "schedule_occurrences"("user_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_user_id_id_key" ON "baselines"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_user_id_task_id_comparison_scope_hash_key" ON "baselines"("user_id", "task_id", "comparison_scope_hash");

-- CreateIndex
CREATE INDEX "runs_user_id_task_id_queued_at_idx" ON "runs"("user_id", "task_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "runs_status_lease_expires_at_idx" ON "runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "runs_user_id_id_key" ON "runs"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_user_id_task_id_id_key" ON "runs"("user_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_user_id_task_id_comparison_scope_hash_id_key" ON "runs"("user_id", "task_id", "comparison_scope_hash", "id");

-- CreateIndex
CREATE UNIQUE INDEX "runs_user_id_id_task_id_task_version_id_key" ON "runs"("user_id", "id", "task_id", "task_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_user_id_id_key" ON "tool_calls"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_run_id_operation_key_attempt_no_key" ON "tool_calls"("run_id", "operation_key", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_user_id_id_key" ON "run_events"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_events_run_id_seq_key" ON "run_events"("run_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_sent_at_available_at_idx" ON "outbox"("sent_at", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_user_id_id_key" ON "outbox"("user_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_id_key" ON "idempotency_records"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_key_hash_key" ON "idempotency_records"("user_id", "scope", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sources_user_id_id_key" ON "sources"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sources_user_id_canonical_url_hash_key" ON "sources"("user_id", "canonical_url_hash");

-- CreateIndex
CREATE UNIQUE INDEX "source_snapshots_user_id_id_key" ON "source_snapshots"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "source_snapshots_user_id_source_id_extractor_version_conten_key" ON "source_snapshots"("user_id", "source_id", "extractor_version", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "source_snapshots_user_id_source_id_id_key" ON "source_snapshots"("user_id", "source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_sources_user_id_id_key" ON "run_sources"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "run_sources_run_id_source_id_key" ON "run_sources"("run_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "run_sources_user_id_run_id_snapshot_id_key" ON "run_sources"("user_id", "run_id", "snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_user_id_id_key" ON "evidence"("user_id", "id");

-- CreateIndex
CREATE INDEX "reports_user_id_published_at_idx" ON "reports"("user_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reports_user_id_id_key" ON "reports"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_user_id_run_id_key" ON "reports"("user_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_user_id_task_id_id_key" ON "reports"("user_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_user_id_run_id_id_key" ON "reports"("user_id", "run_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claims_user_id_id_key" ON "claims"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claims_user_id_task_id_id_key" ON "claims"("user_id", "task_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claims_report_id_order_key" ON "claims"("report_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "claim_evidence_user_id_id_key" ON "claim_evidence"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_evidence_claim_id_evidence_id_key" ON "claim_evidence"("claim_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_records_user_id_id_key" ON "change_records"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "change_evidence_user_id_id_key" ON "change_evidence"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "change_evidence_change_record_id_evidence_id_side_key" ON "change_evidence"("change_record_id", "evidence_id", "side");

-- CreateIndex
CREATE INDEX "inbox_items_user_id_read_at_created_at_idx" ON "inbox_items"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_items_user_id_id_key" ON "inbox_items"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inbox_items_user_id_report_id_key" ON "inbox_items"("user_id", "report_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_id_key" ON "notifications"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_run_id_kind_key" ON "notifications"("user_id", "run_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_user_id_id_key" ON "feedback"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_user_id_id_key" ON "bookmarks"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_user_id_source_id_key" ON "bookmarks"("user_id", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "notes_user_id_id_key" ON "notes"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "report_questions_user_id_id_key" ON "report_questions"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "question_evidence_user_id_id_key" ON "question_evidence"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "question_evidence_question_id_evidence_id_key" ON "question_evidence"("question_id", "evidence_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_id_current_version_id_fkey" FOREIGN KEY ("user_id", "id", "current_version_id") REFERENCES "task_versions"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "task_versions" ADD CONSTRAINT "task_versions_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_user_id_task_id_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "run_id") REFERENCES "runs"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_user_id_task_id_comparison_scope_hash_complete_r_fkey" FOREIGN KEY ("user_id", "task_id", "comparison_scope_hash", "complete_run_id") REFERENCES "runs"("user_id", "task_id", "comparison_scope_hash", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_task_id_task_version_id_fkey" FOREIGN KEY ("user_id", "task_id", "task_version_id") REFERENCES "task_versions"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_task_id_occurrence_id_fkey" FOREIGN KEY ("user_id", "task_id", "occurrence_id") REFERENCES "schedule_occurrences"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_task_id_parent_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "parent_run_id") REFERENCES "runs"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_task_id_comparison_scope_hash_baseline_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "comparison_scope_hash", "baseline_run_id") REFERENCES "runs"("user_id", "task_id", "comparison_scope_hash", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_aggregate_id_fkey" FOREIGN KEY ("user_id", "aggregate_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_user_id_source_id_snapshot_id_fkey" FOREIGN KEY ("user_id", "source_id", "snapshot_id") REFERENCES "source_snapshots"("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_user_id_run_id_snapshot_id_fkey" FOREIGN KEY ("user_id", "run_id", "snapshot_id") REFERENCES "run_sources"("user_id", "run_id", "snapshot_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_run_id_task_id_task_version_id_fkey" FOREIGN KEY ("user_id", "run_id", "task_id", "task_version_id") REFERENCES "runs"("user_id", "id", "task_id", "task_version_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_task_id_baseline_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "baseline_run_id") REFERENCES "runs"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_user_id_task_id_report_id_fkey" FOREIGN KEY ("user_id", "task_id", "report_id") REFERENCES "reports"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_user_id_claim_id_fkey" FOREIGN KEY ("user_id", "claim_id") REFERENCES "claims"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_records" ADD CONSTRAINT "change_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_records" ADD CONSTRAINT "change_records_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_records" ADD CONSTRAINT "change_records_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_records" ADD CONSTRAINT "change_records_user_id_old_source_id_old_snapshot_id_fkey" FOREIGN KEY ("user_id", "old_source_id", "old_snapshot_id") REFERENCES "source_snapshots"("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_records" ADD CONSTRAINT "change_records_user_id_source_id_new_snapshot_id_fkey" FOREIGN KEY ("user_id", "source_id", "new_snapshot_id") REFERENCES "source_snapshots"("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_evidence" ADD CONSTRAINT "change_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_evidence" ADD CONSTRAINT "change_evidence_user_id_change_record_id_fkey" FOREIGN KEY ("user_id", "change_record_id") REFERENCES "change_records"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "change_evidence" ADD CONSTRAINT "change_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_run_id_report_id_fkey" FOREIGN KEY ("user_id", "run_id", "report_id") REFERENCES "reports"("user_id", "run_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_task_id_claim_id_fkey" FOREIGN KEY ("user_id", "task_id", "claim_id") REFERENCES "claims"("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report_questions" ADD CONSTRAINT "report_questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report_questions" ADD CONSTRAINT "report_questions_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "report_questions" ADD CONSTRAINT "report_questions_user_id_followup_run_id_fkey" FOREIGN KEY ("user_id", "followup_run_id") REFERENCES "runs"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_evidence" ADD CONSTRAINT "question_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_evidence" ADD CONSTRAINT "question_evidence_user_id_question_id_fkey" FOREIGN KEY ("user_id", "question_id") REFERENCES "report_questions"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_evidence" ADD CONSTRAINT "question_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence"("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 以下为 Prisma 6 无法表达的部分索引与行内约束，必须随迁移保留。
-- PostgreSQL 是活动执行事实源；队列去重不替代本约束。
CREATE UNIQUE INDEX run_one_active_per_task ON runs(task_id)
WHERE status IN ('queued', 'running', 'recovering', 'cancel_requested');
CREATE INDEX tasks_due_active ON tasks(next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE UNIQUE INDEX feedback_source_once ON feedback(user_id, task_id, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX feedback_claim_once ON feedback(user_id, task_id, claim_id) WHERE claim_id IS NOT NULL;

ALTER TABLE users ADD CONSTRAINT user_email_nonempty CHECK (length(btrim(normalized_email)) > 0);
ALTER TABLE sessions ADD CONSTRAINT session_hashes_only CHECK (token_hash ~ '^[0-9a-f]{64}$' AND csrf_token_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE tasks ADD CONSTRAINT task_revision_positive CHECK (revision >= 1 AND schedule_revision >= 1);
ALTER TABLE tasks ADD CONSTRAINT task_title_nonempty CHECK (length(btrim(title)) > 0);
ALTER TABLE task_versions ADD CONSTRAINT task_version_valid CHECK (version >= 1 AND config_schema_version = 1 AND comparison_scope_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(config_json) = 'object');
ALTER TABLE schedule_occurrences ADD CONSTRAINT occurrence_counters_valid CHECK (schedule_revision >= 1 AND missed_count >= 0);
ALTER TABLE runs ADD CONSTRAINT run_counters_valid CHECK (lease_epoch >= 0 AND recovery_count >= 0);
ALTER TABLE runs ADD CONSTRAINT run_scope_hash_valid CHECK (comparison_scope_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE runs ADD CONSTRAINT run_json_shapes_valid CHECK (jsonb_typeof(budget_json) = 'object' AND jsonb_typeof(usage_json) = 'object' AND jsonb_typeof(feedback_snapshot_json) = 'array');
ALTER TABLE runs ADD CONSTRAINT run_complete_status_valid CHECK (
  (status <> 'succeeded' OR COALESCE(coverage_json->>'completeness' = 'complete', false)) AND
  (status <> 'partial' OR COALESCE(coverage_json->>'completeness' = 'partial', false)) AND
  (outcome IS NULL OR outcome NOT IN ('baseline', 'no_important_change') OR (status = 'succeeded' AND COALESCE(coverage_json->>'completeness' = 'complete', false)))
);
ALTER TABLE tool_calls ADD CONSTRAINT tool_attempt_valid CHECK (attempt_no >= 1);
ALTER TABLE run_events ADD CONSTRAINT event_sequence_and_version_valid CHECK (seq >= 1 AND schema_version = 1);
ALTER TABLE run_events ADD CONSTRAINT event_type_valid CHECK (type IN (
  'run.queued', 'run.started', 'run.recovering', 'step.started', 'step.completed',
  'tool.started', 'tool.completed', 'tool.failed', 'budget.updated', 'coverage.updated',
  'report.published', 'run.completed', 'run.failed', 'run.canceled'
));
ALTER TABLE outbox ADD CONSTRAINT outbox_run_aggregate CHECK (aggregate_type = 'run' AND attempts >= 0);
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_response_valid CHECK (response_code IS NULL OR response_code BETWEEN 100 AND 599);
ALTER TABLE sources ADD CONSTRAINT source_url_hash_valid CHECK (canonical_url_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE source_snapshots ADD CONSTRAINT snapshot_hash_valid CHECK (content_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE run_sources ADD CONSTRAINT observation_result_valid CHECK (fetch_status <> 'succeeded' OR snapshot_id IS NOT NULL);
ALTER TABLE evidence ADD CONSTRAINT evidence_quote_valid CHECK (length(btrim(quote)) > 0 AND quote_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE reports ADD CONSTRAINT report_schema_valid CHECK (schema_version = 1 AND jsonb_typeof(limitations_json) = 'array');
ALTER TABLE claims ADD CONSTRAINT claim_order_valid CHECK ("order" >= 0 AND length(btrim(text)) > 0);
ALTER TABLE change_records ADD CONSTRAINT change_old_snapshot_pair CHECK ((old_source_id IS NULL) = (old_snapshot_id IS NULL));
ALTER TABLE change_records ADD CONSTRAINT change_values_valid CHECK (
  (kind <> 'changed' OR (old_snapshot_id IS NOT NULL AND new_snapshot_id IS NOT NULL AND old_value IS NOT NULL AND new_value IS NOT NULL)) AND
  (kind <> 'new' OR (old_source_id IS NULL AND old_snapshot_id IS NULL AND old_value IS NULL AND new_snapshot_id IS NOT NULL AND new_value IS NOT NULL))
);
ALTER TABLE notifications ADD CONSTRAINT notification_report_required CHECK (kind = 'run_issue' OR report_id IS NOT NULL);
ALTER TABLE feedback ADD CONSTRAINT feedback_exactly_one_target CHECK (num_nonnulls(source_id, claim_id) = 1);
ALTER TABLE notes ADD CONSTRAINT note_exactly_one_target CHECK (num_nonnulls(source_id, report_id) = 1);
ALTER TABLE notes ADD CONSTRAINT note_revision_positive CHECK (revision >= 1);

-- 不能用 CHECK 跨表判断基线是否完整、事实是否至少有一条引用、变化是否有双方证据。
-- 上述条件由交付事务在锁定 Run 后验证；owner 与同任务/同来源一致性已由复合外键约束。
-- LangGraph 的 checkpoint schema/migration 由其适配器单独管理，本迁移不创建或修改其表。
