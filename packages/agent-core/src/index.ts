/** LangGraph 适配层占位；持久化编排器将在 Issue #3/#14 实现。 */
export interface AgentRuntimeBoundary {
  readonly kind: "langgraph";
}
