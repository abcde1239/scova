-- Immutable versioned comparison facts and page identities; never duplicate page bodies.
ALTER TABLE "reports" ADD COLUMN "comparison_json" JSONB;
