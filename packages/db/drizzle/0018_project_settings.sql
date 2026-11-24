CREATE TABLE "project_settings" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"requirements" text DEFAULT '' NOT NULL,
	"preferred_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_autonomy" text DEFAULT 'budgeted' NOT NULL,
	"updated_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_settings_pkey" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "project_settings_goal_length" CHECK (char_length("project_settings"."goal") <= 600),
	CONSTRAINT "project_settings_requirements_length" CHECK (char_length("project_settings"."requirements") <= 1200),
	CONSTRAINT "project_settings_source_count" CHECK (CASE WHEN jsonb_typeof("project_settings"."preferred_sources") = 'array' THEN jsonb_array_length("project_settings"."preferred_sources") <= 8 ELSE false END),
	CONSTRAINT "project_settings_autonomy_valid" CHECK ("project_settings"."default_autonomy" IN ('ask', 'budgeted', 'autonomous'))
);
--> statement-breakpoint
ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_project_fkey" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE cascade ON UPDATE no action;