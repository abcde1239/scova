import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Budget, Coverage, Mode, TaskConfig, Usage } from "@scova/contracts";
import type { ModelResponse, ReadPage, SearchResponse, StructuredInput } from "@scova/connectors";

export interface AgentTools {
  search: (operationKey: string, query: string) => Promise<SearchResponse>;
  read: (operationKey: string, url: string) => Promise<ReadPage>;
  model: (operationKey: string, input: StructuredInput) => Promise<ModelResponse>;
}

export interface AgentContext {
  runId: string;
  userId: string;
  taskVersionId: string;
  mode: Mode;
  config: TaskConfig;
  budget: Budget;
  usage: Usage;
  deadlineAt: Date;
  signal: AbortSignal;
  /** Must check cancellation/lease. With allowDeadline=true, only elapsed deadline is permitted. */
  assertActive: (allowDeadline?: boolean) => Promise<void>;
  demoReason?: string;
}

export interface AgentCitation {
  pageId: string;
  quote: string;
}

export interface AgentClaim {
  kind: "fact" | "inference" | "conflict" | "insufficient";
  text: string;
  citations: AgentCitation[];
  questionIds: string[];
}

export interface AgentPage extends ReadPage {
  id: string;
  questionIds: string[];
}

export interface AgentCandidate {
  schemaVersion: 1;
  runId: string;
  userId: string;
  taskVersionId: string;
  mode: Mode;
  demoReason?: string;
  title: string;
  claims: AgentClaim[];
  pages: AgentPage[];
  coverage: Coverage;
  /** Comparison requires #17 baseline contract; this Agent never invents a baseline outcome. */
  comparison: "not_performed";
}

export interface AgentDependencies {
  tools: AgentTools;
  checkpointer: BaseCheckpointSaver;
  /** Explicit promoted checkpoint for resume; only thread identity for a new execution. */
  config: RunnableConfig;
  promote: (config: RunnableConfig) => Promise<void>;
  onStep?: (step: string, phase: "started" | "completed") => Promise<void>;
  /** True only when config explicitly identifies the legal checkpoint copied into this epoch. */
  resume?: boolean;
  now?: () => number;
}

export class AgentError extends Error {
  constructor(
    public readonly code: "NO_EVIDENCE" | "INVALID_STATE" | "ABORTED" | "INVALID_OUTPUT",
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}
