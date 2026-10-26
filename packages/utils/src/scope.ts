import { createHash } from "node:crypto";

/** Shared effective scope policy for explicit and scheduled Runs. */
export function effectiveRunScopeHash(versionHash: string, mode: "live" | "demo"): string {
  return createHash("sha256")
    .update(JSON.stringify(["run-scope-v2", versionHash, mode, "scova-comparison-v1"]))
    .digest("hex");
}
