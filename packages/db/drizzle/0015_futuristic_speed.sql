CREATE TABLE "workflow_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"artifact_node_id" text,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp (6) with time zone,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_notifications_channel_valid" CHECK (channel = 'in_app')
);
--> statement-breakpoint
CREATE TABLE "workflow_template_executions" (
	"user_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	CONSTRAINT "workflow_template_executions_user_id_template_id_template_version_pk" PRIMARY KEY("user_id","template_id","template_version"),
	CONSTRAINT "workflow_template_executions_version_valid" CHECK ("workflow_template_executions"."template_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"delivery" text NOT NULL,
	"graph_json" jsonb NOT NULL,
	"fields_json" jsonb NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_templates_version_valid" CHECK ("workflow_templates"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "input_json" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "draft_preview_json" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_owner_id_key" ON "workflow_runs" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "workflow_notifications" ADD CONSTRAINT "workflow_notifications_owner_run_fkey" FOREIGN KEY ("user_id","workflow_run_id") REFERENCES "public"."workflow_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_template_executions" ADD CONSTRAINT "workflow_template_executions_version_fkey" FOREIGN KEY ("user_id","workflow_id","version_id") REFERENCES "public"."workflow_versions"("user_id","workflow_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_notifications_delivery_key" ON "workflow_notifications" USING btree ("workflow_run_id","node_id","user_id","channel");--> statement-breakpoint
CREATE INDEX "workflow_notifications_history_idx" ON "workflow_notifications" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflow_template_executions_workflow_idx" ON "workflow_template_executions" USING btree ("user_id","workflow_id");--> statement-breakpoint
CREATE INDEX "workflow_templates_user_created_idx" ON "workflow_templates" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_fkey" FOREIGN KEY ("user_id","workflow_id") REFERENCES "public"."workflows"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_source_valid" CHECK ((version_id IS NOT NULL AND draft_preview_json IS NULL) OR (version_id IS NULL AND preview AND draft_preview_json IS NOT NULL));