-- Literal owner filters remain mandatory; these indexes do not grant cross-user access.
CREATE INDEX bookmarks_library_page ON bookmarks(user_id, created_at DESC, id DESC);
CREATE INDEX notes_library_page ON notes(user_id, updated_at DESC, id DESC);
CREATE INDEX source_snapshots_library_fts ON source_snapshots
USING GIN (to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(text_body, '')));
CREATE INDEX notes_library_fts ON notes USING GIN (to_tsvector('simple'::regconfig, body));
CREATE INDEX run_sources_library_history
ON run_sources(user_id, source_id, snapshot_id, observed_at DESC, id DESC)
WHERE fetch_status = 'succeeded' AND snapshot_id IS NOT NULL;
CREATE INDEX run_sources_library_latest
ON run_sources(user_id, source_id, observed_at DESC, id DESC)
WHERE fetch_status = 'succeeded' AND snapshot_id IS NOT NULL;
CREATE INDEX source_snapshots_expired_body
ON source_snapshots(text_expires_at, id)
WHERE text_body IS NOT NULL AND text_expires_at IS NOT NULL;
