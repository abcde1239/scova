-- First SQLite business migration. Based on PostgreSQL schema revision 0022.
-- Values use strict SQLite storage classes. Timestamps are UTC ISO text with six decimal places.
-- Library search indexes will be installed with the SQLite search repository.

CREATE TABLE "agent_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'openai_chat_completions',
    "encrypted_api_key" TEXT NOT NULL,
    "web_search" TEXT NOT NULL DEFAULT 'disabled',
    "active" INTEGER NOT NULL DEFAULT 0 CHECK ("active" IN (0, 1)),
    "draft_active" INTEGER NOT NULL DEFAULT 0 CHECK ("draft_active" IN (0, 1)),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "agent_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "agent_provider_revision_positive" CHECK ("agent_providers"."revision" > 0),
    CONSTRAINT "agent_provider_web_search_valid" CHECK ("agent_providers"."web_search" = 'disabled' OR ("agent_providers"."web_search" = 'openai_responses' AND "agent_providers"."protocol" IN ('openai_chat_completions', 'openai_json')) OR ("agent_providers"."web_search" = 'anthropic_web_search' AND "agent_providers"."protocol" = 'anthropic_messages'))
) STRICT;

CREATE TABLE "baselines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "comparison_scope_hash" TEXT NOT NULL,
    "complete_run_id" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "baselines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "baselines_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "baselines_user_id_task_id_comparison_scope_hash_complete_r_fkey" FOREIGN KEY ("user_id", "task_id", "comparison_scope_hash", "complete_run_id") REFERENCES "runs" ("user_id", "task_id", "comparison_scope_hash", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "bookmarks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "bookmarks_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "change_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "change_record_id" TEXT NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "side" TEXT NOT NULL CHECK ("side" IN ('old', 'new')),
    CONSTRAINT "change_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "change_evidence_user_id_change_record_id_fkey" FOREIGN KEY ("user_id", "change_record_id") REFERENCES "change_records" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "change_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "change_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('baseline', 'new', 'duplicate', 'duplicate_candidate', 'changed', 'non_material', 'uncertain')),
    "old_source_id" TEXT,
    "old_snapshot_id" TEXT,
    "new_snapshot_id" TEXT,
    "fact_key" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "importance" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    CONSTRAINT "change_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "change_records_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "change_records_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "change_records_user_id_old_source_id_old_snapshot_id_fkey" FOREIGN KEY ("user_id", "old_source_id", "old_snapshot_id") REFERENCES "source_snapshots" ("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "change_records_user_id_source_id_new_snapshot_id_fkey" FOREIGN KEY ("user_id", "source_id", "new_snapshot_id") REFERENCES "source_snapshots" ("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "change_old_snapshot_pair" CHECK ((old_source_id IS NULL) = (old_snapshot_id IS NULL)),
    CONSTRAINT "change_values_valid" CHECK ((kind <> 'changed' OR (old_snapshot_id IS NOT NULL AND new_snapshot_id IS NOT NULL AND old_value IS NOT NULL AND new_value IS NOT NULL)) AND (kind <> 'new' OR (old_source_id IS NULL AND old_snapshot_id IS NULL AND old_value IS NULL AND new_snapshot_id IS NOT NULL AND new_value IS NOT NULL)))
) STRICT;

CREATE TABLE "claim_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "claim_id" TEXT NOT NULL,
    "evidence_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL CHECK ("relation" IN ('supports', 'contradicts')),
    CONSTRAINT "claim_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "claim_evidence_user_id_claim_id_fkey" FOREIGN KEY ("user_id", "claim_id") REFERENCES "claims" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "claim_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "claims" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('fact', 'inference', 'conflict', 'insufficient', 'model_answer')),
    "text" TEXT NOT NULL,
    "confidence_label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    CONSTRAINT "claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "claims_user_id_task_id_report_id_fkey" FOREIGN KEY ("user_id", "task_id", "report_id") REFERENCES "reports" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "claim_order_valid" CHECK ("order" >= 0 AND length(trim(text)) > 0)
) STRICT;

CREATE TABLE "evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "selector_json" TEXT NOT NULL CHECK ("selector_json" IS NULL OR json_valid("selector_json")),
    "quote_hash" TEXT NOT NULL,
    "captured_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "evidence_user_id_run_id_snapshot_id_fkey" FOREIGN KEY ("user_id", "run_id", "snapshot_id") REFERENCES "run_sources" ("user_id", "run_id", "snapshot_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "evidence_quote_valid" CHECK (length(trim(quote)) > 0 AND (length(quote_hash) = 64 AND quote_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE TABLE "feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "source_id" TEXT,
    "claim_id" TEXT,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('irrelevant', 'known', 'deeper')),
    "active" INTEGER NOT NULL DEFAULT 1 CHECK ("active" IN (0, 1)),
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "feedback_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "feedback_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "feedback_user_id_task_id_claim_id_fkey" FOREIGN KEY ("user_id", "task_id", "claim_id") REFERENCES "claims" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "feedback_exactly_one_target" CHECK (((source_id IS NOT NULL) + (claim_id IS NOT NULL)) = 1)
) STRICT;

CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'completed')),
    "response_code" INTEGER,
    "resource_id" TEXT,
    "expires_at" TEXT NOT NULL,
    CONSTRAINT "idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "idempotency_response_valid" CHECK (response_code IS NULL OR response_code BETWEEN 100 AND 599)
) STRICT;

CREATE TABLE "inbox_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "read_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "inbox_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "inbox_items_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "notes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "source_id" TEXT,
    "report_id" TEXT,
    "body" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "notes_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "notes_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "note_exactly_one_target" CHECK (((source_id IS NOT NULL) + (report_id IS NOT NULL)) = 1),
    CONSTRAINT "note_revision_positive" CHECK (revision >= 1)
) STRICT;

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "report_id" TEXT,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('summary', 'important_change', 'run_issue')),
    "read_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "notifications_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "notifications_user_id_run_id_report_id_fkey" FOREIGN KEY ("user_id", "run_id", "report_id") REFERENCES "reports" ("user_id", "run_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "notification_report_required" CHECK (kind = 'run_issue' OR report_id IS NOT NULL)
) STRICT;

CREATE TABLE "outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL DEFAULT 'run',
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" TEXT NOT NULL CHECK ("payload" IS NULL OR json_valid("payload")),
    "available_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "lease_expires_at" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TEXT,
    CONSTRAINT "outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "outbox_user_id_aggregate_id_fkey" FOREIGN KEY ("user_id", "aggregate_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "outbox_run_aggregate" CHECK (aggregate_type = 'run' AND attempts >= 0)
) STRICT;

CREATE TABLE "project_conversation_turns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "input" TEXT NOT NULL CHECK ("input" IS NULL OR json_valid("input")),
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "draft_id" TEXT,
    "created_at" TEXT NOT NULL,
    "expires_at" TEXT,
    "execution_deadline_at" TEXT,
    CONSTRAINT "project_conversation_turns_owner_thread_fkey" FOREIGN KEY ("user_id", "project_id", "thread_id") REFERENCES "project_threads" ("user_id", "project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_conversation_turns_project_fkey" FOREIGN KEY ("user_id", "project_id") REFERENCES "projects" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "project_research_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "config" TEXT NOT NULL CHECK ("config" IS NULL OR json_valid("config")),
    "confirmed_task_id" TEXT,
    "confirmed_run_id" TEXT,
    "confirmed_start" INTEGER,
    CONSTRAINT "project_research_drafts_owner_thread_fkey" FOREIGN KEY ("user_id", "project_id", "thread_id") REFERENCES "project_threads" ("user_id", "project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_research_drafts_project_fkey" FOREIGN KEY ("user_id", "project_id") REFERENCES "projects" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "project_settings" (
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "requirements" TEXT NOT NULL DEFAULT '',
    "preferred_sources" TEXT NOT NULL DEFAULT '[]' CHECK ("preferred_sources" IS NULL OR json_valid("preferred_sources")),
    "default_autonomy" TEXT NOT NULL DEFAULT 'budgeted',
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "project_settings_pkey" PRIMARY KEY ("user_id", "project_id"),
    CONSTRAINT "project_settings_project_fkey" FOREIGN KEY ("user_id", "project_id") REFERENCES "projects" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_settings_goal_length" CHECK (length("project_settings"."goal") <= 600),
    CONSTRAINT "project_settings_requirements_length" CHECK (length("project_settings"."requirements") <= 1200),
    CONSTRAINT "project_settings_source_count" CHECK (CASE WHEN json_type("project_settings"."preferred_sources") = 'array' THEN json_array_length("project_settings"."preferred_sources") <= 8 ELSE false END),
    CONSTRAINT "project_settings_autonomy_valid" CHECK ("project_settings"."default_autonomy" IN ('ask', 'budgeted', 'autonomous'))
) STRICT;

CREATE TABLE "project_tasks" (
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("user_id", "task_id"),
    CONSTRAINT "project_tasks_project_fkey" FOREIGN KEY ("user_id", "project_id") REFERENCES "projects" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_tasks_task_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "project_thread_attachments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "thread_id" TEXT,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "excerpt" TEXT,
    "ready_at" TEXT,
    "updated_at" TEXT NOT NULL,
    CONSTRAINT "project_thread_attachments_owner_thread_fkey" FOREIGN KEY ("user_id", "thread_id") REFERENCES "project_threads" ("user_id", "id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "project_thread_attachments_owner_thread_check" CHECK (("project_thread_attachments"."user_id" is null) = ("project_thread_attachments"."thread_id" is null)),
    CONSTRAINT "project_thread_attachments_size_check" CHECK ("project_thread_attachments"."byte_length" between 1 and 262144),
    CONSTRAINT "project_thread_attachments_format_check" CHECK ("project_thread_attachments"."format" in ('csv', 'txt', 'pdf', 'md', 'json', 'tsv', 'png', 'jpeg', 'webp')),
    CONSTRAINT "project_thread_attachments_excerpt_check" CHECK (length("project_thread_attachments"."excerpt") <= 1200)
) STRICT;

CREATE TABLE "project_thread_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL CHECK ("payload" IS NULL OR json_valid("payload")),
    "refs" TEXT NOT NULL DEFAULT '[]' CHECK ("refs" IS NULL OR json_valid("refs")),
    "status" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "project_thread_items_owner_thread_fkey" FOREIGN KEY ("user_id", "thread_id") REFERENCES "project_threads" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_thread_items_owner_turn_fkey" FOREIGN KEY ("user_id", "thread_id", "turn_id") REFERENCES "project_conversation_turns" ("user_id", "thread_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "project_thread_items_seq_positive" CHECK (seq > 0)
) STRICT;

CREATE TABLE "project_thread_run_origins" (
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "draft_revision" INTEGER NOT NULL,
    CONSTRAINT "project_thread_run_origins_user_id_run_id_pk" PRIMARY KEY ("user_id", "run_id"),
    CONSTRAINT "project_thread_run_origins_owner_run_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "project_thread_run_origins_owner_thread_fkey" FOREIGN KEY ("user_id", "project_id", "thread_id") REFERENCES "project_threads" ("user_id", "project_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "project_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "is_default" INTEGER NOT NULL DEFAULT 0 CHECK ("is_default" IN (0, 1)),
    "archived_at" TEXT,
    "last_activity_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "project_threads_owner_project_fkey" FOREIGN KEY ("user_id", "project_id") REFERENCES "projects" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "projects_name_nonempty" CHECK (length(trim(name)) > 0)
) STRICT;

CREATE TABLE "question_evidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "evidence_id" TEXT NOT NULL,
    CONSTRAINT "question_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "question_evidence_user_id_question_id_fkey" FOREIGN KEY ("user_id", "question_id") REFERENCES "report_questions" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "question_evidence_user_id_evidence_id_fkey" FOREIGN KEY ("user_id", "evidence_id") REFERENCES "evidence" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "report_attachment_objects" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "report_attachment_objects_user_id_id_pk" PRIMARY KEY ("user_id", "id")
) STRICT;

CREATE TABLE "report_exports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "renderer_version" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'markdown',
    "markdown" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    CONSTRAINT "report_exports_owner_report_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "report_exports_format_valid" CHECK (format IN ('markdown', 'json')),
    CONSTRAINT "report_exports_payload_valid" CHECK (byte_length BETWEEN 1 AND 262144 AND byte_length = length(CAST(markdown AS BLOB)) AND (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
    CONSTRAINT "report_exports_lifetime_valid" CHECK (renderer_version > 0 AND expires_at > created_at)
) STRICT;

CREATE TABLE "report_questions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer_json" TEXT CHECK ("answer_json" IS NULL OR json_valid("answer_json")),
    "followup_run_id" TEXT,
    "revision_run_id" TEXT,
    "context_json" TEXT CHECK ("context_json" IS NULL OR json_valid("context_json")),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "report_questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "report_questions_user_id_report_id_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "report_questions_user_id_followup_run_id_fkey" FOREIGN KEY ("user_id", "followup_run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "report_questions_user_id_revision_run_id_fkey" FOREIGN KEY ("user_id", "revision_run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
) STRICT;

CREATE TABLE "report_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "report_version" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content_key" TEXT NOT NULL,
    "content" BLOB,
    "object_id" TEXT,
    "object_size" INTEGER,
    "metadata" TEXT NOT NULL CHECK ("metadata" IS NULL OR json_valid("metadata")),
    "created_at" TEXT NOT NULL,
    "expires_at" TEXT,
    CONSTRAINT "report_resources_owner_report_fkey" FOREIGN KEY ("user_id", "report_id") REFERENCES "reports" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "report_resources_owner_object_fkey" FOREIGN KEY ("user_id", "object_id") REFERENCES "report_attachment_objects" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "report_resources_purpose_valid" CHECK (purpose IN ('source-host-chart', 'reference-csv')),
    CONSTRAINT "report_resources_payload_valid" CHECK ((length(content_key) = 64 AND content_key NOT GLOB '*[^0-9a-f]*') AND version > 0 AND ( (object_id IS NULL AND object_size IS NULL AND content IS NOT NULL AND length(CAST(content AS BLOB)) BETWEEN 1 AND CASE WHEN purpose = 'source-host-chart' THEN 262144 ELSE 262144 END) OR (purpose = 'reference-csv' AND content IS NULL AND object_id IS NOT NULL AND object_size IS NOT NULL AND object_size BETWEEN 262145 AND 10485760) )),
    CONSTRAINT "report_resources_expiry_valid" CHECK ((purpose = 'source-host-chart' AND expires_at IS NOT NULL AND expires_at > created_at) OR (purpose = 'reference-csv' AND expires_at IS NULL))
) STRICT;

CREATE TABLE "reports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_version_id" TEXT NOT NULL,
    "baseline_run_id" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "format" TEXT NOT NULL CHECK ("format" IN ('brief', 'list', 'comparison', 'research_report')),
    "completeness" TEXT NOT NULL CHECK ("completeness" IN ('complete', 'partial')),
    "limitations_json" TEXT NOT NULL DEFAULT '[]' CHECK ("limitations_json" IS NULL OR json_valid("limitations_json")),
    "comparison_json" TEXT CHECK ("comparison_json" IS NULL OR json_valid("comparison_json")),
    "feedback_effects_json" TEXT NOT NULL DEFAULT '[]' CHECK ("feedback_effects_json" IS NULL OR json_valid("feedback_effects_json")),
    "published_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reports_user_id_run_id_task_id_task_version_id_fkey" FOREIGN KEY ("user_id", "run_id", "task_id", "task_version_id") REFERENCES "runs" ("user_id", "id", "task_id", "task_version_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "reports_user_id_task_id_baseline_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "baseline_run_id") REFERENCES "runs" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "report_schema_valid" CHECK (schema_version = 1 AND json_type(limitations_json) = 'array'),
    CONSTRAINT "report_feedback_effects_valid" CHECK (json_type(feedback_effects_json) = 'array')
) STRICT;

CREATE TABLE "run_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL CHECK ("payload" IS NULL OR json_valid("payload")),
    "occurred_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "run_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "run_events_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "event_sequence_and_version_valid" CHECK (seq >= 1 AND schema_version = 1),
    CONSTRAINT "event_type_valid" CHECK (type IN ( 'run.queued', 'run.started', 'run.recovering', 'step.started', 'step.completed', 'tool.started', 'tool.completed', 'tool.failed', 'budget.updated', 'coverage.updated', 'research.updated', 'report.published', 'run.completed', 'run.failed', 'run.canceled' ))
) STRICT;

CREATE TABLE "run_graph_snapshots" (
    "run_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "state_json" TEXT NOT NULL CHECK ("state_json" IS NULL OR json_valid("state_json")),
    CONSTRAINT "run_graph_snapshots_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "run_graph_snapshot_seq_valid" CHECK ("run_graph_snapshots"."seq" >= 1)
) STRICT;

CREATE TABLE "run_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "snapshot_id" TEXT,
    "requested_url" TEXT NOT NULL,
    "fetched_url" TEXT,
    "observed_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "fetch_status" TEXT NOT NULL CHECK ("fetch_status" IN ('succeeded', 'failed')),
    "error_code" TEXT,
    "relevance" REAL,
    "metadata_json" TEXT NOT NULL DEFAULT '{}' CHECK ("metadata_json" IS NULL OR json_valid("metadata_json")),
    CONSTRAINT "run_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "run_sources_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "run_sources_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "run_sources_user_id_source_id_snapshot_id_fkey" FOREIGN KEY ("user_id", "source_id", "snapshot_id") REFERENCES "source_snapshots" ("user_id", "source_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "observation_result_valid" CHECK (fetch_status <> 'succeeded' OR snapshot_id IS NOT NULL)
) STRICT;

CREATE TABLE "runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "task_version_id" TEXT NOT NULL,
    "comparison_scope_hash" TEXT NOT NULL,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('demo', 'live')),
    "trigger" TEXT NOT NULL CHECK ("trigger" IN ('manual', 'scheduled', 'retry', 'followup')),
    "occurrence_id" TEXT,
    "parent_run_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued', 'running', 'recovering', 'cancel_requested', 'canceled', 'succeeded', 'partial', 'failed')),
    "queued_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "started_at" TEXT,
    "deadline_at" TEXT,
    "finished_at" TEXT,
    "lease_owner" TEXT,
    "lease_epoch" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TEXT,
    "recovery_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested_at" TEXT,
    "baseline_run_id" TEXT,
    "followup_config_json" TEXT CHECK ("followup_config_json" IS NULL OR json_valid("followup_config_json")),
    "conversation_context_json" TEXT CHECK ("conversation_context_json" IS NULL OR json_valid("conversation_context_json")),
    "feedback_snapshot_json" TEXT NOT NULL DEFAULT '[]' CHECK ("feedback_snapshot_json" IS NULL OR json_valid("feedback_snapshot_json")),
    "budget_json" TEXT NOT NULL CHECK ("budget_json" IS NULL OR json_valid("budget_json")),
    "usage_json" TEXT NOT NULL DEFAULT '{}' CHECK ("usage_json" IS NULL OR json_valid("usage_json")),
    "coverage_json" TEXT CHECK ("coverage_json" IS NULL OR json_valid("coverage_json")),
    "outcome" TEXT CHECK ("outcome" IN ('baseline', 'important_change', 'new_findings', 'no_important_change', 'inconclusive')),
    "failure_code" TEXT,
    "checkpoint_ref" TEXT CHECK ("checkpoint_ref" IS NULL OR json_valid("checkpoint_ref")),
    "search_configuration_hash" TEXT,
    CONSTRAINT "runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "runs_user_id_task_id_task_version_id_fkey" FOREIGN KEY ("user_id", "task_id", "task_version_id") REFERENCES "task_versions" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "runs_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "runs_user_id_task_id_occurrence_id_fkey" FOREIGN KEY ("user_id", "task_id", "occurrence_id") REFERENCES "schedule_occurrences" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "runs_user_id_task_id_parent_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "parent_run_id") REFERENCES "runs" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "runs_user_id_task_id_comparison_scope_hash_baseline_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "comparison_scope_hash", "baseline_run_id") REFERENCES "runs" ("user_id", "task_id", "comparison_scope_hash", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "run_counters_valid" CHECK (lease_epoch >= 0 AND recovery_count >= 0),
    CONSTRAINT "run_scope_hash_valid" CHECK ((length(comparison_scope_hash) = 64 AND comparison_scope_hash NOT GLOB '*[^0-9a-f]*')),
    CONSTRAINT "run_complete_status_valid" CHECK ((status <> 'succeeded' OR COALESCE(coverage_json->>'completeness' = 'complete', false)) AND (status <> 'partial' OR COALESCE(coverage_json->>'completeness' = 'partial', false)) AND (outcome IS NULL OR outcome NOT IN ('baseline', 'no_important_change') OR (status = 'succeeded' AND COALESCE(coverage_json->>'completeness' = 'complete', false)))),
    CONSTRAINT "run_json_shapes_valid" CHECK (json_type(budget_json) = 'object' AND json_type(usage_json) = 'object' AND ( feedback_snapshot_json = '[]' OR ( json_type(feedback_snapshot_json) = 'object' AND json_type(feedback_snapshot_json, '$.schemaVersion') = 'integer' AND feedback_snapshot_json->>'schemaVersion' = 1 AND feedback_snapshot_json->>'userId' = user_id AND feedback_snapshot_json->>'taskId' = task_id AND json_type(feedback_snapshot_json, '$.items') = 'array' ) ) IS TRUE)
) STRICT;

CREATE TABLE "schedule_occurrences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "schedule_revision" INTEGER NOT NULL,
    "scheduled_at" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created' CHECK ("status" IN ('created', 'skipped_overlap', 'missed', 'paused')),
    "run_id" TEXT,
    "missed_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "schedule_occurrences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "schedule_occurrences_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "schedule_occurrences_user_id_task_id_run_id_fkey" FOREIGN KEY ("user_id", "task_id", "run_id") REFERENCES "runs" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "occurrence_counters_valid" CHECK (schedule_revision >= 1 AND missed_count >= 0)
) STRICT;

CREATE TABLE "search_configurations" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "id" TEXT NOT NULL,
    "default_mode" TEXT NOT NULL,
    "protocol" TEXT,
    "custom_template" TEXT CHECK ("custom_template" IS NULL OR json_valid("custom_template")),
    "base_url" TEXT,
    "content_mode" TEXT,
    "encrypted_api_key" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "search_configurations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "search_configuration_revision_positive" CHECK ("search_configurations"."revision" > 0),
    CONSTRAINT "search_configuration_mode_valid" CHECK ("search_configurations"."default_mode" IN ('api', 'searxng')),
    CONSTRAINT "search_configuration_api_complete" CHECK (("search_configurations"."protocol" IS NULL AND "search_configurations"."base_url" IS NULL AND "search_configurations"."content_mode" IS NULL AND "search_configurations"."encrypted_api_key" IS NULL AND "search_configurations"."custom_template" IS NULL AND "search_configurations"."default_mode" = 'searxng') OR ("search_configurations"."protocol" IS NOT NULL AND "search_configurations"."protocol" IN ('deepseek', 'perplexity', 'tavily', 'custom_json') AND "search_configurations"."base_url" IS NOT NULL AND length("search_configurations"."base_url") > 0 AND "search_configurations"."content_mode" IS NOT NULL AND "search_configurations"."content_mode" IN ('reader', 'prefer_api') AND "search_configurations"."encrypted_api_key" IS NOT NULL AND length("search_configurations"."encrypted_api_key") > 0 AND (("search_configurations"."protocol" = 'custom_json' AND "search_configurations"."content_mode" = 'reader' AND "search_configurations"."custom_template" IS NOT NULL) OR ("search_configurations"."protocol" <> 'custom_json' AND "search_configurations"."custom_template" IS NULL))))
) STRICT;

CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,
    "revoked_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "session_hashes_only" CHECK ((length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*') AND (length(csrf_token_hash) = 64 AND csrf_token_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE TABLE "source_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "extractor_version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "published_at" TEXT,
    "text_body" TEXT,
    "text_expires_at" TEXT,
    "metadata_json" TEXT NOT NULL DEFAULT '{}' CHECK ("metadata_json" IS NULL OR json_valid("metadata_json")),
    CONSTRAINT "source_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "source_snapshots_user_id_source_id_fkey" FOREIGN KEY ("user_id", "source_id") REFERENCES "sources" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "snapshot_hash_valid" CHECK ((length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "canonical_url_hash" TEXT NOT NULL,
    "first_seen_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "source_url_hash_valid" CHECK ((length(canonical_url_hash) = 64 AND canonical_url_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;

CREATE TABLE "task_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "input_text" TEXT,
    "config_schema_version" INTEGER NOT NULL DEFAULT 1,
    "config_json" TEXT NOT NULL CHECK ("config_json" IS NULL OR json_valid("config_json")),
    "comparison_scope_hash" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "task_versions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "task_versions_user_id_task_id_fkey" FOREIGN KEY ("user_id", "task_id") REFERENCES "tasks" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "task_version_valid" CHECK (version >= 1 AND config_schema_version = 1 AND (length(comparison_scope_hash) = 64 AND comparison_scope_hash NOT GLOB '*[^0-9a-f]*') AND json_type(config_json) = 'object')
) STRICT;

CREATE TABLE "tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'paused', 'archived')),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "current_version_id" TEXT,
    "schedule_revision" INTEGER NOT NULL DEFAULT 1,
    "next_run_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "updated_at" TEXT NOT NULL,
    "archived_at" TEXT,
    CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "tasks_user_id_id_current_version_id_fkey" FOREIGN KEY ("user_id", "id", "current_version_id") REFERENCES "task_versions" ("user_id", "task_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "task_revision_positive" CHECK (revision >= 1 AND schedule_revision >= 1),
    CONSTRAINT "task_title_nonempty" CHECK (length(trim(title)) > 0)
) STRICT;

CREATE TABLE "tool_calls" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved' CHECK ("status" IN ('reserved', 'running', 'succeeded', 'failed', 'unknown')),
    "input_summary" TEXT NOT NULL,
    "reserved_budget" TEXT NOT NULL CHECK ("reserved_budget" IS NULL OR json_valid("reserved_budget")),
    "usage" TEXT CHECK ("usage" IS NULL OR json_valid("usage")),
    "output_ref" TEXT CHECK ("output_ref" IS NULL OR json_valid("output_ref")),
    "started_at" TEXT,
    "finished_at" TEXT,
    CONSTRAINT "tool_calls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "tool_calls_user_id_run_id_fkey" FOREIGN KEY ("user_id", "run_id") REFERENCES "runs" ("user_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "tool_attempt_valid" CHECK (attempt_no >= 1)
) STRICT;

CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "avatar_version" TEXT,
    "default_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "notification_preference" TEXT NOT NULL DEFAULT '{"mode":"summary","runIssues":true}' CHECK ("notification_preference" IS NULL OR json_valid("notification_preference")),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "user_email_nonempty" CHECK (length(trim(normalized_email)) > 0)
) STRICT;

CREATE TABLE "workflow_notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "workflow_run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "artifact_node_id" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'in_app',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "workflow_notifications_owner_run_fkey" FOREIGN KEY ("user_id", "workflow_run_id") REFERENCES "workflow_runs" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_notifications_channel_valid" CHECK (channel = 'in_app')
) STRICT;

CREATE TABLE "workflow_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version_id" TEXT,
    "mode" TEXT NOT NULL CHECK ("mode" IN ('demo', 'live')),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "nodes_json" TEXT NOT NULL CHECK ("nodes_json" IS NULL OR json_valid("nodes_json")),
    "start_key_hash" TEXT NOT NULL,
    "input_json" TEXT CHECK ("input_json" IS NULL OR json_valid("input_json")),
    "preview" INTEGER NOT NULL DEFAULT 0 CHECK ("preview" IN (0, 1)),
    "draft_preview_json" TEXT CHECK ("draft_preview_json" IS NULL OR json_valid("draft_preview_json")),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "started_at" TEXT,
    "finished_at" TEXT,
    "next_check_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "failure_code" TEXT,
    CONSTRAINT "workflow_runs_version_fkey" FOREIGN KEY ("user_id", "workflow_id", "version_id") REFERENCES "workflow_versions" ("user_id", "workflow_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_runs_workflow_fkey" FOREIGN KEY ("user_id", "workflow_id") REFERENCES "workflows" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_runs_source_valid" CHECK ((version_id IS NOT NULL AND draft_preview_json IS NULL) OR (version_id IS NULL AND preview AND draft_preview_json IS NOT NULL)),
    CONSTRAINT "workflow_runs_checkpoint_valid" CHECK (json_type(nodes_json) = 'array' AND status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'canceled', 'failed') AND (finished_at IS NULL) = (status IN ('queued', 'running', 'cancel_requested')))
) STRICT;

CREATE TABLE "workflow_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "draft_revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "graph_json" TEXT NOT NULL CHECK ("graph_json" IS NULL OR json_valid("graph_json")),
    "bindings_json" TEXT NOT NULL CHECK ("bindings_json" IS NULL OR json_valid("bindings_json")),
    "published_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "workflow_versions_workflow_fkey" FOREIGN KEY ("user_id", "workflow_id") REFERENCES "workflows" ("user_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_versions_valid" CHECK ("workflow_versions"."version" >= 1 AND "workflow_versions"."draft_revision" >= 1)
) STRICT;

CREATE TABLE "workflows" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "draft_json" TEXT NOT NULL CHECK ("draft_json" IS NULL OR json_valid("draft_json")),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "workflows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflows_revision_valid" CHECK ("workflows"."revision" >= 1)
) STRICT;

CREATE TABLE "workflow_template_executions" (
    "user_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    CONSTRAINT "workflow_template_executions_user_id_template_id_template_version_pk" PRIMARY KEY ("user_id", "template_id", "template_version"),
    CONSTRAINT "workflow_template_executions_version_fkey" FOREIGN KEY ("user_id", "workflow_id", "version_id") REFERENCES "workflow_versions" ("user_id", "workflow_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_template_executions_version_valid" CHECK ("workflow_template_executions"."template_version" >= 1)
) STRICT;

CREATE TABLE "workflow_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "delivery" TEXT NOT NULL,
    "graph_json" TEXT NOT NULL CHECK ("graph_json" IS NULL OR json_valid("graph_json")),
    "fields_json" TEXT NOT NULL CHECK ("fields_json" IS NULL OR json_valid("fields_json")),
    "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z'),
    CONSTRAINT "workflow_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "workflow_templates_version_valid" CHECK ("workflow_templates"."version" >= 1)
) STRICT;

CREATE INDEX "agent_providers_user_id_idx" ON "agent_providers" ("user_id");
CREATE UNIQUE INDEX "agent_providers_one_active_per_user" ON "agent_providers" ("user_id") WHERE "agent_providers"."active" = true;
CREATE UNIQUE INDEX "agent_providers_one_draft_active_per_user" ON "agent_providers" ("user_id") WHERE "agent_providers"."draft_active" = true;
CREATE UNIQUE INDEX "baselines_user_id_id_key" ON "baselines" ("user_id", "id");
CREATE UNIQUE INDEX "baselines_user_id_task_id_comparison_scope_hash_key" ON "baselines" ("user_id", "task_id", "comparison_scope_hash");
CREATE UNIQUE INDEX "bookmarks_user_id_id_key" ON "bookmarks" ("user_id", "id");
CREATE UNIQUE INDEX "bookmarks_user_id_source_id_key" ON "bookmarks" ("user_id", "source_id");
CREATE INDEX "bookmarks_library_page" ON "bookmarks" ("user_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "change_evidence_user_id_id_key" ON "change_evidence" ("user_id", "id");
CREATE UNIQUE INDEX "change_evidence_change_record_id_evidence_id_side_key" ON "change_evidence" ("change_record_id", "evidence_id", "side");
CREATE UNIQUE INDEX "change_records_user_id_id_key" ON "change_records" ("user_id", "id");
CREATE UNIQUE INDEX "claim_evidence_user_id_id_key" ON "claim_evidence" ("user_id", "id");
CREATE UNIQUE INDEX "claim_evidence_claim_id_evidence_id_key" ON "claim_evidence" ("claim_id", "evidence_id");
CREATE UNIQUE INDEX "claims_user_id_id_key" ON "claims" ("user_id", "id");
CREATE UNIQUE INDEX "claims_user_id_task_id_id_key" ON "claims" ("user_id", "task_id", "id");
CREATE UNIQUE INDEX "claims_report_id_order_key" ON "claims" ("report_id", "order");
CREATE UNIQUE INDEX "evidence_user_id_id_key" ON "evidence" ("user_id", "id");
CREATE UNIQUE INDEX "feedback_user_id_id_key" ON "feedback" ("user_id", "id");
CREATE UNIQUE INDEX "feedback_source_once" ON "feedback" ("user_id", "task_id", "source_id") WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX "feedback_claim_once" ON "feedback" ("user_id", "task_id", "claim_id") WHERE claim_id IS NOT NULL;
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records" ("expires_at");
CREATE UNIQUE INDEX "idempotency_records_user_id_id_key" ON "idempotency_records" ("user_id", "id");
CREATE UNIQUE INDEX "idempotency_records_user_id_scope_key_hash_key" ON "idempotency_records" ("user_id", "scope", "key_hash");
CREATE INDEX "inbox_items_user_id_read_at_created_at_idx" ON "inbox_items" ("user_id", "read_at", "created_at");
CREATE UNIQUE INDEX "inbox_items_user_id_id_key" ON "inbox_items" ("user_id", "id");
CREATE UNIQUE INDEX "inbox_items_user_id_report_id_key" ON "inbox_items" ("user_id", "report_id");
CREATE INDEX "inbox_history_page" ON "inbox_items" ("user_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "notes_user_id_id_key" ON "notes" ("user_id", "id");
CREATE INDEX "notes_library_page" ON "notes" ("user_id", "updated_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "notifications_user_id_id_key" ON "notifications" ("user_id", "id");
CREATE UNIQUE INDEX "notifications_user_id_run_id_kind_key" ON "notifications" ("user_id", "run_id", "kind");
CREATE UNIQUE INDEX "outbox_dedupe_key_key" ON "outbox" ("dedupe_key");
CREATE INDEX "outbox_sent_at_available_at_idx" ON "outbox" ("sent_at", "available_at");
CREATE UNIQUE INDEX "outbox_user_id_id_key" ON "outbox" ("user_id", "id");
CREATE INDEX "project_conversation_turns_project_idx" ON "project_conversation_turns" ("user_id", "project_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "project_conversation_turns_owner_thread_id_key" ON "project_conversation_turns" ("user_id", "thread_id", "id");
CREATE UNIQUE INDEX "project_conversation_turns_running_key" ON "project_conversation_turns" ("user_id", "thread_id") WHERE status = 'running';
CREATE INDEX "project_conversation_turns_running_deadline_idx" ON "project_conversation_turns" ("execution_deadline_at") WHERE status = 'running';
CREATE INDEX "project_research_drafts_thread_idx" ON "project_research_drafts" ("user_id", "project_id", "thread_id");
CREATE INDEX "project_tasks_project_idx" ON "project_tasks" ("user_id", "project_id", "task_id");
CREATE UNIQUE INDEX "project_thread_attachments_content_key" ON "project_thread_attachments" ("thread_id", "digest");
CREATE INDEX "project_thread_attachments_cleanup_idx" ON "project_thread_attachments" ("updated_at") WHERE "project_thread_attachments"."thread_id" is null or "project_thread_attachments"."ready_at" is null;
CREATE UNIQUE INDEX "project_thread_items_thread_seq_key" ON "project_thread_items" ("thread_id", "seq");
CREATE INDEX "project_thread_items_owner_turn_idx" ON "project_thread_items" ("user_id", "thread_id", "turn_id");
CREATE INDEX "project_thread_run_origins_owner_thread_idx" ON "project_thread_run_origins" ("user_id", "project_id", "thread_id");
CREATE UNIQUE INDEX "project_threads_owner_project_id_key" ON "project_threads" ("user_id", "project_id", "id");
CREATE UNIQUE INDEX "project_threads_owner_id_key" ON "project_threads" ("user_id", "id");
CREATE UNIQUE INDEX "project_threads_default_key" ON "project_threads" ("user_id", "project_id") WHERE is_default;
CREATE INDEX "project_threads_project_activity_idx" ON "project_threads" ("user_id", "project_id", "last_activity_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "projects_user_id_id_key" ON "projects" ("user_id", "id");
CREATE INDEX "projects_owner_page_idx" ON "projects" ("user_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "question_evidence_user_id_id_key" ON "question_evidence" ("user_id", "id");
CREATE UNIQUE INDEX "question_evidence_question_id_evidence_id_key" ON "question_evidence" ("question_id", "evidence_id");
CREATE UNIQUE INDEX "report_exports_owner_report_format_version" ON "report_exports" ("user_id", "report_id", "format", "renderer_version");
CREATE INDEX "report_exports_expires_at_id_idx" ON "report_exports" ("expires_at", "id");
CREATE UNIQUE INDEX "report_questions_user_id_id_key" ON "report_questions" ("user_id", "id");
CREATE INDEX "report_questions_conversation_idx" ON "report_questions" ("user_id", "report_id", "created_at", "id");
CREATE UNIQUE INDEX "report_resources_content_key" ON "report_resources" ("user_id", "report_id", "purpose", "report_version", "version", "content_key");
CREATE UNIQUE INDEX "report_resources_owner_object_idx" ON "report_resources" ("user_id", "object_id");
CREATE INDEX "reports_user_id_published_at_idx" ON "reports" ("user_id", "published_at" DESC);
CREATE UNIQUE INDEX "reports_user_id_id_key" ON "reports" ("user_id", "id");
CREATE UNIQUE INDEX "reports_user_id_run_id_key" ON "reports" ("user_id", "run_id");
CREATE UNIQUE INDEX "reports_user_id_task_id_id_key" ON "reports" ("user_id", "task_id", "id");
CREATE UNIQUE INDEX "reports_user_id_run_id_id_key" ON "reports" ("user_id", "run_id", "id");
CREATE INDEX "reports_history_page" ON "reports" ("user_id", "published_at" DESC, "id" DESC);
CREATE INDEX "reports_task_history_page" ON "reports" ("user_id", "task_id", "published_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "run_events_user_id_id_key" ON "run_events" ("user_id", "id");
CREATE UNIQUE INDEX "run_events_run_id_seq_key" ON "run_events" ("run_id", "seq");
CREATE UNIQUE INDEX "run_sources_user_id_id_key" ON "run_sources" ("user_id", "id");
CREATE UNIQUE INDEX "run_sources_run_id_source_id_key" ON "run_sources" ("run_id", "source_id");
CREATE UNIQUE INDEX "run_sources_user_id_run_id_snapshot_id_key" ON "run_sources" ("user_id", "run_id", "snapshot_id");
CREATE INDEX "run_sources_library_history" ON "run_sources" ("user_id", "source_id", "snapshot_id", "observed_at" DESC, "id" DESC) WHERE fetch_status = 'succeeded' AND snapshot_id IS NOT NULL;
CREATE INDEX "run_sources_library_latest" ON "run_sources" ("user_id", "source_id", "observed_at" DESC, "id" DESC) WHERE fetch_status = 'succeeded' AND snapshot_id IS NOT NULL;
CREATE INDEX "runs_user_id_task_id_queued_at_idx" ON "runs" ("user_id", "task_id", "queued_at" DESC);
CREATE INDEX "runs_status_lease_expires_at_idx" ON "runs" ("status", "lease_expires_at");
CREATE UNIQUE INDEX "runs_user_id_id_key" ON "runs" ("user_id", "id");
CREATE UNIQUE INDEX "runs_user_id_task_id_id_key" ON "runs" ("user_id", "task_id", "id");
CREATE UNIQUE INDEX "runs_user_id_task_id_comparison_scope_hash_id_key" ON "runs" ("user_id", "task_id", "comparison_scope_hash", "id");
CREATE UNIQUE INDEX "runs_user_id_id_task_id_task_version_id_key" ON "runs" ("user_id", "id", "task_id", "task_version_id");
CREATE UNIQUE INDEX "run_one_active_per_task" ON "runs" ("task_id") WHERE status IN ('queued', 'running', 'recovering', 'cancel_requested');
CREATE INDEX "runs_history_page" ON "runs" ("user_id", "task_id", "queued_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "schedule_occurrences_user_id_id_key" ON "schedule_occurrences" ("user_id", "id");
CREATE UNIQUE INDEX "schedule_occurrences_task_id_schedule_revision_scheduled_at_key" ON "schedule_occurrences" ("task_id", "schedule_revision", "scheduled_at");
CREATE UNIQUE INDEX "schedule_occurrences_user_id_task_id_id_key" ON "schedule_occurrences" ("user_id", "task_id", "id");
CREATE UNIQUE INDEX "search_configurations_id_key" ON "search_configurations" ("id");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" ("token_hash");
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions" ("user_id", "expires_at");
CREATE UNIQUE INDEX "sessions_user_id_id_key" ON "sessions" ("user_id", "id");
CREATE UNIQUE INDEX "source_snapshots_user_id_id_key" ON "source_snapshots" ("user_id", "id");
CREATE UNIQUE INDEX "source_snapshots_user_id_source_id_extractor_version_conten_key" ON "source_snapshots" ("user_id", "source_id", "extractor_version", "content_hash");
CREATE UNIQUE INDEX "source_snapshots_user_id_source_id_id_key" ON "source_snapshots" ("user_id", "source_id", "id");
CREATE INDEX "source_snapshots_expired_body" ON "source_snapshots" ("text_expires_at", "id") WHERE text_body IS NOT NULL AND text_expires_at IS NOT NULL;
CREATE UNIQUE INDEX "sources_user_id_id_key" ON "sources" ("user_id", "id");
CREATE UNIQUE INDEX "sources_user_id_canonical_url_hash_key" ON "sources" ("user_id", "canonical_url_hash");
CREATE UNIQUE INDEX "task_versions_user_id_id_key" ON "task_versions" ("user_id", "id");
CREATE UNIQUE INDEX "task_versions_user_id_task_id_version_key" ON "task_versions" ("user_id", "task_id", "version");
CREATE UNIQUE INDEX "task_versions_user_id_task_id_id_key" ON "task_versions" ("user_id", "task_id", "id");
CREATE INDEX "tasks_user_id_status_updated_at_idx" ON "tasks" ("user_id", "status", "updated_at");
CREATE UNIQUE INDEX "tasks_user_id_id_key" ON "tasks" ("user_id", "id");
CREATE INDEX "tasks_due_active" ON "tasks" ("next_run_at", "id") WHERE "status" = 'active' AND "next_run_at" IS NOT NULL;
CREATE INDEX "tasks_history_page" ON "tasks" ("user_id", "updated_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "tool_calls_user_id_id_key" ON "tool_calls" ("user_id", "id");
CREATE UNIQUE INDEX "tool_calls_run_id_operation_key_attempt_no_key" ON "tool_calls" ("run_id", "operation_key", "attempt_no");
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users" ("normalized_email");
CREATE UNIQUE INDEX "workflow_notifications_delivery_key" ON "workflow_notifications" ("workflow_run_id", "node_id", "user_id", "channel");
CREATE INDEX "workflow_notifications_history_idx" ON "workflow_notifications" ("user_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "workflow_runs_owner_id_key" ON "workflow_runs" ("user_id", "id");
CREATE UNIQUE INDEX "workflow_runs_start_key" ON "workflow_runs" ("user_id", "workflow_id", "start_key_hash");
CREATE INDEX "workflow_runs_history_idx" ON "workflow_runs" ("user_id", "workflow_id", "created_at" DESC, "id" DESC);
CREATE INDEX "workflow_runs_due_idx" ON "workflow_runs" ("next_check_at", "id") WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE UNIQUE INDEX "workflow_versions_owner_key" ON "workflow_versions" ("user_id", "workflow_id", "id");
CREATE UNIQUE INDEX "workflow_versions_sequence_key" ON "workflow_versions" ("workflow_id", "version");
CREATE UNIQUE INDEX "workflow_versions_revision_key" ON "workflow_versions" ("workflow_id", "draft_revision");
CREATE UNIQUE INDEX "workflows_user_id_id_key" ON "workflows" ("user_id", "id");
CREATE INDEX "workflows_user_created_idx" ON "workflows" ("user_id", "created_at" DESC, "id" DESC);
CREATE INDEX "workflow_template_executions_workflow_idx" ON "workflow_template_executions" ("user_id", "workflow_id");
CREATE INDEX "workflow_templates_user_created_idx" ON "workflow_templates" ("user_id", "created_at" DESC, "id" DESC);

-- PostgreSQL can null only turn_id in a composite key. Keep the owning thread in SQLite.
CREATE TRIGGER project_thread_turn_deleted
BEFORE DELETE ON project_conversation_turns
FOR EACH ROW BEGIN
    UPDATE project_thread_items SET turn_id = NULL
    WHERE user_id = OLD.user_id AND thread_id = OLD.thread_id AND turn_id = OLD.id;
END;
