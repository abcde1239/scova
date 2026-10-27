-- 仅新增本次交付的解释；不改写历史正文、证据、比较清单或配置版本。
ALTER TABLE reports ADD COLUMN feedback_effects_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 旧Run保留空数组；新Run使用带owner/task的版本化对象，不改写历史快照。
ALTER TABLE runs DROP CONSTRAINT run_json_shapes_valid;
ALTER TABLE runs ADD CONSTRAINT run_json_shapes_valid CHECK (
  jsonb_typeof(budget_json) = 'object'
  AND jsonb_typeof(usage_json) = 'object'
  AND (
    feedback_snapshot_json = '[]'::jsonb
    OR (
      jsonb_typeof(feedback_snapshot_json) = 'object'
      AND feedback_snapshot_json->'schemaVersion' = '1'::jsonb
      AND feedback_snapshot_json->>'userId' = user_id::text
      AND feedback_snapshot_json->>'taskId' = task_id::text
      AND jsonb_typeof(feedback_snapshot_json->'items') = 'array'
    )
  ) IS TRUE
);
ALTER TABLE reports ADD CONSTRAINT report_feedback_effects_valid
  CHECK (jsonb_typeof(feedback_effects_json) = 'array');
