ALTER TABLE "run_events" DROP CONSTRAINT "event_type_valid";--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "event_type_valid" CHECK (type IN (
  'run.queued', 'run.started', 'run.recovering', 'step.started', 'step.completed',
  'tool.started', 'tool.completed', 'tool.failed', 'budget.updated', 'coverage.updated', 'research.updated',
  'report.published', 'run.completed', 'run.failed', 'run.canceled'
));