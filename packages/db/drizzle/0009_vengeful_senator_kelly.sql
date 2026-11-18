CREATE TABLE "run_graph_snapshots" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"state_json" jsonb NOT NULL,
	CONSTRAINT "run_graph_snapshot_seq_valid" CHECK ("run_graph_snapshots"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE "search_configurations" DROP CONSTRAINT "search_configuration_api_complete";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "search_configuration_hash" char(64);--> statement-breakpoint
ALTER TABLE "search_configurations" ADD COLUMN "custom_template" jsonb;--> statement-breakpoint
ALTER TABLE "run_graph_snapshots" ADD CONSTRAINT "run_graph_snapshots_user_id_run_id_fkey" FOREIGN KEY ("user_id","run_id") REFERENCES "public"."runs"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_configurations" ADD CONSTRAINT "search_configuration_api_complete" CHECK (("search_configurations"."protocol" IS NULL AND "search_configurations"."base_url" IS NULL AND "search_configurations"."content_mode" IS NULL AND "search_configurations"."encrypted_api_key" IS NULL AND "search_configurations"."custom_template" IS NULL AND "search_configurations"."default_mode" = 'searxng') OR ("search_configurations"."protocol" IS NOT NULL AND "search_configurations"."protocol" IN ('deepseek', 'perplexity', 'tavily', 'custom_json') AND "search_configurations"."base_url" IS NOT NULL AND length("search_configurations"."base_url") > 0 AND "search_configurations"."content_mode" IS NOT NULL AND "search_configurations"."content_mode" IN ('reader', 'prefer_api') AND "search_configurations"."encrypted_api_key" IS NOT NULL AND length("search_configurations"."encrypted_api_key") > 0 AND (("search_configurations"."protocol" = 'custom_json' AND "search_configurations"."content_mode" = 'reader' AND "search_configurations"."custom_template" IS NOT NULL) OR ("search_configurations"."protocol" <> 'custom_json' AND "search_configurations"."custom_template" IS NULL))));