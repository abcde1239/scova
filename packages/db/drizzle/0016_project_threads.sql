CREATE TABLE "project_thread_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" uuid,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_thread_items_seq_positive" CHECK (seq > 0)
);
--> statement-breakpoint
CREATE TABLE "project_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "project_threads" ADD CONSTRAINT "project_threads_owner_project_fkey" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."projects"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_thread_items_thread_seq_key" ON "project_thread_items" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "project_thread_items_owner_turn_idx" ON "project_thread_items" USING btree ("user_id","thread_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_threads_owner_project_id_key" ON "project_threads" USING btree ("user_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_threads_owner_id_key" ON "project_threads" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_threads_default_key" ON "project_threads" USING btree ("user_id","project_id") WHERE is_default;--> statement-breakpoint
CREATE INDEX "project_threads_project_activity_idx" ON "project_threads" USING btree ("user_id","project_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_conversation_turns_owner_thread_id_key" ON "project_conversation_turns" USING btree ("user_id","thread_id","id");--> statement-breakpoint
ALTER TABLE "project_thread_items" ADD CONSTRAINT "project_thread_items_owner_thread_fkey" FOREIGN KEY ("user_id","thread_id") REFERENCES "public"."project_threads"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_thread_items" ADD CONSTRAINT "project_thread_items_owner_turn_fkey" FOREIGN KEY ("user_id","thread_id","turn_id") REFERENCES "public"."project_conversation_turns"("user_id","thread_id","id") ON DELETE SET NULL ("turn_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_conversation_turns" ADD CONSTRAINT "project_conversation_turns_owner_thread_fkey" FOREIGN KEY ("user_id","project_id","thread_id") REFERENCES "public"."project_threads"("user_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Each legacy project has one default thread, including projects with an empty conversation.
WITH history AS (
    SELECT user_id, project_id, min(created_at) AS first_turn_at, max(created_at) AS last_turn_at
    FROM project_conversation_turns
    GROUP BY user_id, project_id
)
INSERT INTO project_threads (id, user_id, project_id, title, is_default, last_activity_at, created_at)
SELECT gen_random_uuid(), project.user_id, project.id, '默认会话', true,
    coalesce(history.last_turn_at, project.created_at), coalesce(history.first_turn_at, project.created_at)
FROM projects AS project
LEFT JOIN history ON history.user_id = project.user_id AND history.project_id = project.id;
--> statement-breakpoint
UPDATE project_conversation_turns AS turn
SET thread_id = thread.id
FROM project_threads AS thread
WHERE thread.user_id = turn.user_id AND thread.project_id = turn.project_id AND thread.is_default;
--> statement-breakpoint
-- Legacy turns have one timestamp. Break ties by turn ID, then by item order within a turn.
INSERT INTO project_thread_items (id, user_id, thread_id, turn_id, seq, kind, payload, refs, created_at)
SELECT gen_random_uuid(), turn.user_id, turn.thread_id, turn.id,
    row_number() OVER (PARTITION BY turn.thread_id ORDER BY turn.created_at, turn.id, item.position),
    item.kind, item.payload, item.refs, turn.created_at
FROM project_conversation_turns AS turn
CROSS JOIN LATERAL (VALUES
    (1, 'message',
        jsonb_build_object('role', 'user', 'text', turn.input->>'message'),
        '[]'::jsonb, jsonb_typeof(turn.input->'message') = 'string'),
    (2, 'message',
        jsonb_build_object('role', 'assistant', 'text', turn.answer),
        CASE WHEN turn.input->>'reportId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN jsonb_build_array(jsonb_build_object('kind', 'report', 'id', (turn.input->>'reportId')::uuid))
            ELSE '[]'::jsonb END,
        turn.answer IS NOT NULL),
    (3, 'plan', jsonb_build_object('draftId', turn.draft_id), '[]'::jsonb, turn.draft_id IS NOT NULL)
) AS item(position, kind, payload, refs, present)
WHERE item.present;
