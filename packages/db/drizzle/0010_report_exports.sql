CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"renderer_version" integer NOT NULL,
	"markdown" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "report_exports_payload_valid" CHECK (byte_length BETWEEN 1 AND 262144 AND byte_length = octet_length(markdown) AND sha256 ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "report_exports_lifetime_valid" CHECK (renderer_version > 0 AND expires_at > created_at)
);
--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_owner_report_fkey" FOREIGN KEY ("user_id","report_id") REFERENCES "public"."reports"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_exports_owner_report_version" ON "report_exports" USING btree ("user_id","report_id","renderer_version");--> statement-breakpoint
CREATE INDEX "report_exports_expires_at_id_idx" ON "report_exports" USING btree ("expires_at","id");