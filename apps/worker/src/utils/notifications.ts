import { NotificationPreferenceSchema, parseContract } from "@scova/contracts";

export function terminalNotificationKind(
  preference: unknown,
  terminal: { status: "succeeded" | "partial" | "failed" | "canceled"; outcome?: string },
): "summary" | "important_change" | "run_issue" | null {
  let parsed;
  try {
    parsed = parseContract(NotificationPreferenceSchema, preference);
  } catch {
    return null;
  }
  if (terminal.status === "canceled") return null;
  if (terminal.status !== "succeeded") return parsed.runIssues ? "run_issue" : null;
  if (parsed.mode === "summary") return "summary";
  return parsed.mode === "important_change" && terminal.outcome === "important_change"
    ? "important_change"
    : null;
}
