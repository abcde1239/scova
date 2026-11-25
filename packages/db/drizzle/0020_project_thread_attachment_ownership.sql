ALTER TABLE "project_thread_attachments" DROP CONSTRAINT "project_thread_attachments_thread_id_project_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "project_thread_attachments" ADD COLUMN "user_id" uuid;--> statement-breakpoint
UPDATE "project_thread_attachments" AS attachment
SET "user_id" = thread."user_id"
FROM "project_threads" AS thread
WHERE attachment."thread_id" = thread."id";--> statement-breakpoint
ALTER TABLE "project_thread_attachments" ADD CONSTRAINT "project_thread_attachments_owner_thread_fkey" FOREIGN KEY ("user_id","thread_id") REFERENCES "public"."project_threads"("user_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_thread_attachments" ADD CONSTRAINT "project_thread_attachments_owner_thread_check" CHECK (("project_thread_attachments"."user_id" is null) = ("project_thread_attachments"."thread_id" is null));