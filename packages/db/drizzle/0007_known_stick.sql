CREATE TABLE "search_configurations" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"id" uuid NOT NULL,
	"default_mode" text NOT NULL,
	"protocol" text,
	"base_url" text,
	"content_mode" text,
	"encrypted_api_key" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_configuration_revision_positive" CHECK ("search_configurations"."revision" > 0),
	CONSTRAINT "search_configuration_mode_valid" CHECK ("search_configurations"."default_mode" IN ('api', 'searxng')),
	CONSTRAINT "search_configuration_api_complete" CHECK (("search_configurations"."protocol" IS NULL AND "search_configurations"."base_url" IS NULL AND "search_configurations"."content_mode" IS NULL AND "search_configurations"."encrypted_api_key" IS NULL AND "search_configurations"."default_mode" = 'searxng') OR ("search_configurations"."protocol" IS NOT NULL AND "search_configurations"."protocol" IN ('deepseek', 'perplexity', 'tavily') AND "search_configurations"."base_url" IS NOT NULL AND length("search_configurations"."base_url") > 0 AND "search_configurations"."content_mode" IS NOT NULL AND "search_configurations"."content_mode" IN ('reader', 'prefer_api') AND "search_configurations"."encrypted_api_key" IS NOT NULL AND length("search_configurations"."encrypted_api_key") > 0))
);
--> statement-breakpoint
ALTER TABLE "search_configurations" ADD CONSTRAINT "search_configurations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_configurations_id_key" ON "search_configurations" USING btree ("id");