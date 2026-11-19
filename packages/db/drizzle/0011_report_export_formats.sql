DROP INDEX "report_exports_owner_report_version";--> statement-breakpoint
ALTER TABLE "report_exports" ADD COLUMN "format" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "report_exports_owner_report_format_version" ON "report_exports" USING btree ("user_id","report_id","format","renderer_version");--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_format_valid" CHECK (format IN ('markdown', 'json'));