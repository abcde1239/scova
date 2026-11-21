CREATE TABLE "project_conversation_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"answer" text,
	"draft_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_research_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"confirmed_task_id" uuid,
	"confirmed_run_id" uuid,
	"confirmed_start" integer
);
--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ADD CONSTRAINT "project_conversation_turns_project_fkey" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_research_drafts" ADD CONSTRAINT "project_research_drafts_project_fkey" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_conversation_turns_project_idx" ON "project_conversation_turns" USING btree ("user_id","project_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_conversation_turns_running_key" ON "project_conversation_turns" USING btree ("user_id","project_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "project_research_drafts_project_idx" ON "project_research_drafts" USING btree ("user_id","project_id");