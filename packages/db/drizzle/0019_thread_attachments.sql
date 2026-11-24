CREATE TABLE "project_thread_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"byte_length" integer NOT NULL,
	"digest" text NOT NULL,
	"storage_key" text NOT NULL,
	"excerpt" text,
	"ready_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_thread_attachments_size_check" CHECK ("project_thread_attachments"."byte_length" between 1 and 262144),
	CONSTRAINT "project_thread_attachments_format_check" CHECK ("project_thread_attachments"."format" in ('csv', 'txt', 'pdf')),
	CONSTRAINT "project_thread_attachments_excerpt_check" CHECK (char_length("project_thread_attachments"."excerpt") <= 1200)
);
--> statement-breakpoint
ALTER TABLE "project_thread_attachments" ADD CONSTRAINT "project_thread_attachments_thread_id_project_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."project_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_thread_attachments_content_key" ON "project_thread_attachments" USING btree ("thread_id","digest");--> statement-breakpoint
CREATE INDEX "project_thread_attachments_cleanup_idx" ON "project_thread_attachments" USING btree ("updated_at") WHERE "project_thread_attachments"."thread_id" is null or "project_thread_attachments"."ready_at" is null;