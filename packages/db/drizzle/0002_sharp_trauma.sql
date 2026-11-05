ALTER TABLE "agent_providers" ADD COLUMN "draft_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent_providers" SET "draft_active" = "active";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_providers_one_draft_active_per_user" ON "agent_providers" USING btree ("user_id") WHERE "agent_providers"."draft_active" = true;
