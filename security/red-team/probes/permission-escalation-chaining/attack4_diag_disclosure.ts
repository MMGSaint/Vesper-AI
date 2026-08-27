import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { isClientError } from "../../../../src/vesper/client/protocol.ts";
import { callsTool } from "./lib.ts";

const runtime = await testRuntime({ providers: [callsTool("diagnostics_report", {})] });
const peer = await enrolCompanion(runtime, { name: "phone", trust: "restricted" });
const gw = createClientGateway(runtime);
// Restricted ceiling: status, conversation, knowledge.read. No operator/status-plus scope needed.
const session = await gw.issueSession({ deviceId: peer.deviceId, scopes: ["conversation"] });
if (isClientError(session)) throw new Error(session.detail);
const turn = await gw.converse(session.token, "diagnostics");
if (isClientError(turn)) throw new Error(turn.detail);
const c = turn.toolCalls.find((x) => x.toolName === "diagnostics_report");
console.log("diagnostics_report allowed to restricted remote device:", c?.decision.allowed, "ok=", c?.result?.ok);
const data = c?.result?.data as any;
console.log("leaked keys:", Object.keys(data ?? {}).join(", "));
console.log("permissions.neverAllowAutonomous:", JSON.stringify(data?.permissions ?? data?.permission ?? "n/a"));
console.log("reportText (first 300):", String(c?.result?.summary ?? "").slice(0, 300));
await runtime.stop();
