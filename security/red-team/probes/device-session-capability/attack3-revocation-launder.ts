/**
 * Hypothesis: `revoked` is claimed terminal ("forgetting is the only way back").
 * setTrust only guards revoked->trusted. Any other hop out of `revoked` is unguarded,
 * and from that hop `trusted` is reachable in one more step.
 */
import { testRuntime, enrolCompanion } from "../../../../src/vesper/test-helpers.ts";
import { createClientGateway } from "../../../../src/vesper/client/gateway.ts";
import { queueProvider, show } from "./lib.ts";

const ALL = ["status","conversation","memory.read","memory.write","knowledge.read","notifications","operator.confirm"] as const;

for (const hop of ["restricted", "pending"] as const) {
  const q = queueProvider();
  const runtime = await testRuntime({ providers: [q.provider] });
  const gw = createClientGateway(runtime);
  const phone = await enrolCompanion(runtime, { name: "phone", trust: "trusted" });

  await runtime.devices.setTrust(phone.deviceId, "revoked");
  console.log(`[${hop}] revoked. direct re-trust ->`,
    JSON.stringify(await runtime.devices.setTrust(phone.deviceId, "trusted")));
  console.log(`[${hop}] re-enrol ->`, JSON.stringify((await runtime.devices.enrol(phone)).reason));

  const step1 = await runtime.devices.setTrust(phone.deviceId, hop);
  console.log(`[${hop}] hop revoked->${hop} ok=${step1.ok} trust=${step1.record?.trust}`);
  const step2 = await runtime.devices.setTrust(phone.deviceId, "trusted");
  console.log(`[${hop}] hop ${hop}->trusted ok=${step2.ok} trust=${step2.record?.trust} revokedAt=${step2.record?.revokedAt}`);

  const s = await gw.issueSession({ deviceId: phone.deviceId, deviceLabel: "phone", scopes: [...ALL] });
  if ("ok" in s) { console.log(`[${hop}] session REFUSED`, JSON.stringify(s)); }
  else {
    console.log(`[${hop}] FULL SESSION RESTORED scopes=${s.scopes.join(",")}`);
    q.push("process_list", {});
    const t = await gw.converse(s.token, "list processes");
    if (!("ok" in t)) show(`[${hop}] post-revocation tool call`, t);
    const m = await gw.listMemory(s.token);
    console.log(`[${hop}] memory.read after revocation:`, "ok" in m ? "DENIED" : `ALLOWED (${m.entries.length} entries)`);
  }
  await runtime.stop();
}
