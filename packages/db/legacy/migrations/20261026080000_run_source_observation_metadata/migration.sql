-- Per-observation collection facts must not overwrite immutable shared snapshot metadata.
ALTER TABLE "run_sources" ADD COLUMN "metadata_json" JSONB NOT NULL DEFAULT '{}';
