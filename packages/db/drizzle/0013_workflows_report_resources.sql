CREATE TABLE "report_resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"report_version" timestamp with time zone NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"content_key" text NOT NULL,
	"content" "bytea" NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "report_resources_purpose_valid" CHECK (purpose IN ('source-host-chart', 'reference-csv')),
	CONSTRAINT "report_resources_payload_valid" CHECK (octet_length(content) BETWEEN 1 AND CASE WHEN purpose = 'source-host-chart' THEN 262144 ELSE 262144 END AND content_key ~ '^[a-f0-9]{64}$' AND version > 0),
	CONSTRAINT "report_resources_expiry_valid" CHECK ((purpose = 'source-host-chart' AND expires_at IS NOT NULL AND expires_at > created_at) OR (purpose = 'reference-csv' AND expires_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"mode" "ServiceMode" NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"nodes_json" jsonb NOT NULL,
	"start_key_hash" text NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (6) with time zone,
	"finished_at" timestamp (6) with time zone,
	"next_check_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"failure_code" text,
	CONSTRAINT "workflow_runs_checkpoint_valid" CHECK (jsonb_typeof(nodes_json) = 'array' AND status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'canceled', 'failed') AND (finished_at IS NULL) = (status IN ('queued', 'running', 'cancel_requested')))
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"draft_revision" integer NOT NULL,
	"title" text NOT NULL,
	"graph_json" jsonb NOT NULL,
	"bindings_json" jsonb NOT NULL,
	"published_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_versions_valid" CHECK ("workflow_versions"."version" >= 1 AND "workflow_versions"."draft_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"draft_json" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_revision_valid" CHECK ("workflows"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "report_resources" ADD CONSTRAINT "report_resources_owner_report_fkey" FOREIGN KEY ("user_id","report_id") REFERENCES "public"."reports"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_resources_content_key" ON "report_resources" USING btree ("user_id","report_id","purpose","report_version","version","content_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_start_key" ON "workflow_runs" USING btree ("user_id","workflow_id","start_key_hash");--> statement-breakpoint
CREATE INDEX "workflow_runs_history_idx" ON "workflow_runs" USING btree ("user_id","workflow_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_runs_due_idx" ON "workflow_runs" USING btree ("next_check_at","id") WHERE status IN ('queued', 'running', 'cancel_requested');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_owner_key" ON "workflow_versions" USING btree ("user_id","workflow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_sequence_key" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_revision_key" ON "workflow_versions" USING btree ("workflow_id","draft_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_user_id_id_key" ON "workflows" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "workflows_user_created_idx" ON "workflows" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_version_fkey" FOREIGN KEY ("user_id","workflow_id","version_id") REFERENCES "public"."workflow_versions"("user_id","workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_fkey" FOREIGN KEY ("user_id","workflow_id") REFERENCES "public"."workflows"("user_id","id") ON DELETE cascade ON UPDATE no action;
