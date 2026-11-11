ALTER TABLE "report_questions" ADD COLUMN "revision_run_id" uuid;--> statement-breakpoint
ALTER TABLE "report_questions" ADD COLUMN "context_json" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation_context_json" jsonb;--> statement-breakpoint
ALTER TABLE "report_questions" ADD CONSTRAINT "report_questions_user_id_revision_run_id_fkey" FOREIGN KEY ("user_id","revision_run_id") REFERENCES "public"."runs"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_questions_conversation_idx" ON "report_questions" USING btree ("user_id","report_id","created_at","id");