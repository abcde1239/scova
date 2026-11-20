CREATE TABLE "project_tasks" (
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "project_tasks_pkey" PRIMARY KEY("user_id","task_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_nonempty" CHECK (length(btrim(name)) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_user_id_id_key" ON "projects" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_fkey" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_task_fkey" FOREIGN KEY ("user_id","task_id") REFERENCES "public"."tasks"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_tasks_project_idx" ON "project_tasks" USING btree ("user_id","project_id","task_id");--> statement-breakpoint
CREATE INDEX "projects_owner_page_idx" ON "projects" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);