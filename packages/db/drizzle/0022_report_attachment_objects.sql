CREATE TABLE "report_attachment_objects" (
	"id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_attachment_objects_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "report_resources" DROP CONSTRAINT "report_resources_payload_valid";--> statement-breakpoint
ALTER TABLE "report_resources" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_resources" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "report_resources" ADD COLUMN "object_size" integer;--> statement-breakpoint
ALTER TABLE "report_resources" ADD CONSTRAINT "report_resources_owner_object_fkey" FOREIGN KEY ("user_id","object_id") REFERENCES "public"."report_attachment_objects"("user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_resources_owner_object_idx" ON "report_resources" USING btree ("user_id","object_id");--> statement-breakpoint
ALTER TABLE "report_resources" ADD CONSTRAINT "report_resources_payload_valid" CHECK (content_key ~ '^[a-f0-9]{64}$' AND version > 0 AND (
                    (object_id IS NULL AND object_size IS NULL AND content IS NOT NULL AND octet_length(content) BETWEEN 1 AND CASE WHEN purpose = 'source-host-chart' THEN 262144 ELSE 262144 END)
                    OR (purpose = 'reference-csv' AND content IS NULL AND object_id IS NOT NULL AND object_size IS NOT NULL AND object_size BETWEEN 262145 AND 10485760)
                ));