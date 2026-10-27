CREATE INDEX tasks_history_page ON tasks(user_id, updated_at DESC, id DESC);
CREATE INDEX reports_history_page ON reports(user_id, published_at DESC, id DESC);
CREATE INDEX reports_task_history_page ON reports(user_id, task_id, published_at DESC, id DESC);
CREATE INDEX inbox_history_page ON inbox_items(user_id, created_at DESC, id DESC);
CREATE INDEX runs_history_page ON runs(user_id, task_id, queued_at DESC, id DESC);
