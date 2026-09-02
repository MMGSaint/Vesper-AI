/**
 * Procedure → skill bridge.
 *
 * A procedure is knowledge of how to perform something.
 * A skill is a packaged executable capability with declared requirements.
 *
 * A procedure may become a candidate skill only through the existing lifecycle:
 * DISCOVERED → VALIDATED → SCANNED → ENABLED. It does not gain new permissions.
 * Execution still passes through ToolRegistry.
 */

import type { Procedure } from "../procedures.ts";
import type { SkillRecord, SkillRegistry, SkillScanContext } from "../skills.ts";

export interface BridgeResult {
  ok: boolean;
  reason?: string;
  skill?: SkillRecord;
}

export async function proposeSkillFromProcedure(
  procedure: Procedure,
  skills: SkillRegistry,
  context: SkillScanContext = {},
): Promise<BridgeResult> {
  if (procedure.state !== "active") {
    return { ok: false, reason: `Procedure is ${procedure.state}, not active.` };
  }
  if (procedure.permissionCeiling === "never") {
    return { ok: false, reason: "A never-tier procedure cannot become a skill." };
  }
  const name = procedure.name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "procedure";
  const record = await skills.discover(
    {
      name,
      version: `1.0.${procedure.version}`,
      description: procedure.purpose.slice(0, 500),
      requiredTools: procedure.requiredTools,
      requiredCapabilities: [],
      platforms: [],
      requiredBinaries: [],
      requiredEnvironment: [],
      trust: "local",
    },
    context,
  );
  if (record.state === "enabled") {
    return { ok: false, reason: "Bridge must not auto-enable a skill.", skill: record };
  }
  return { ok: true, skill: record };
}
