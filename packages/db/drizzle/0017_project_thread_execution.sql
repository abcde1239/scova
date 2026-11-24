CREATE TABLE "project_thread_run_origins" (
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"draft_revision" integer NOT NULL,
	CONSTRAINT "project_thread_run_origins_user_id_run_id_pk" PRIMARY KEY("user_id","run_id")
);
--> statement-breakpoint
DROP INDEX "project_research_drafts_project_idx";--> statement-breakpoint
DROP INDEX "project_conversation_turns_running_key";--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ADD COLUMN "execution_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_research_drafts" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
-- Projects created after 0016 may have no default thread yet.
WITH legacy_projects AS (
    SELECT user_id, project_id FROM project_research_drafts
    UNION
    SELECT user_id, project_id FROM project_conversation_turns WHERE thread_id IS NULL
)
INSERT INTO project_threads (id, user_id, project_id, title, is_default, last_activity_at, created_at)
SELECT gen_random_uuid(), project.user_id, project.id, '默认会话', true, project.created_at, project.created_at
FROM projects AS project
JOIN legacy_projects AS legacy ON legacy.user_id = project.user_id AND legacy.project_id = project.id
ON CONFLICT (user_id, project_id) WHERE is_default DO NOTHING;
--> statement-breakpoint
UPDATE project_conversation_turns AS turn
SET thread_id = thread.id
FROM project_threads AS thread
WHERE turn.thread_id IS NULL
    AND thread.user_id = turn.user_id AND thread.project_id = turn.project_id AND thread.is_default;
--> statement-breakpoint
UPDATE project_conversation_turns SET execution_deadline_at = expires_at WHERE expires_at IS NOT NULL;
--> statement-breakpoint
UPDATE project_research_drafts AS draft
SET thread_id = thread.id
FROM project_threads AS thread
WHERE thread.user_id = draft.user_id AND thread.project_id = draft.project_id AND thread.is_default;
--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_research_drafts" ALTER COLUMN "thread_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project_thread_run_origins" ADD CONSTRAINT "project_thread_run_origins_owner_run_fkey" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_thread_run_origins" ADD CONSTRAINT "project_thread_run_origins_owner_thread_fkey" FOREIGN KEY ("user_id","project_id","thread_id") REFERENCES "public"."project_threads"("user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_thread_run_origins_owner_thread_idx" ON "project_thread_run_origins" USING btree ("user_id","project_id","thread_id");--> statement-breakpoint
ALTER TABLE "project_research_drafts" ADD CONSTRAINT "project_research_drafts_owner_thread_fkey" FOREIGN KEY ("user_id","project_id","thread_id") REFERENCES "public"."project_threads"("user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_conversation_turns_running_deadline_idx" ON "project_conversation_turns" USING btree ("execution_deadline_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "project_research_drafts_thread_idx" ON "project_research_drafts" USING btree ("user_id","project_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_conversation_turns_running_key" ON "project_conversation_turns" USING btree ("user_id","thread_id") WHERE status = 'running';