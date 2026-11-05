CREATE TABLE "agent_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"protocol" text DEFAULT 'openai_chat_completions' NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_provider_revision_positive" CHECK ("agent_providers"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_providers" ADD CONSTRAINT "agent_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_providers_user_id_idx" ON "agent_providers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_providers_one_active_per_user" ON "agent_providers" USING btree ("user_id") WHERE "agent_providers"."active" = true;