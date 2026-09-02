import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createKeyring,
  decryptEnvelope,
  encryptEnvelope,
  restoreKeyring,
  revokeDevice,
  rotateKeyring,
  serializeKeyring,
} from "./crypto.ts";

describe("continuity crypto", () => {
  it("round-trips plaintext", () => {
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_a",
      plaintext: "Sarah works at Y",
      ring,
    });
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plaintext.toString("utf8"), "Sarah works at Y");
    assert.equal(envelope.ciphertext.includes("Sarah"), false);
  });

  it("rejects a tampered payload", () => {
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_a",
      plaintext: "hello",
      ring,
    });
    envelope.ciphertext = Buffer.from("not-the-ciphertext").toString("base64");
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /authentication failed/);
  });

  it("rejects the wrong keyring", () => {
    const a = createKeyring();
    const b = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_a",
      plaintext: "secret-note",
      ring: a,
    });
    const result = decryptEnvelope(envelope, b);
    assert.equal(result.ok, false);
  });

  it("revoked devices cannot encrypt or decrypt", () => {
    const ring = createKeyring();
    revokeDevice(ring, "dev_lost");
    assert.throws(() =>
      encryptEnvelope({
        recordId: "sync_1",
        entityType: "memory",
        sourceDeviceId: "dev_lost",
        plaintext: "nope",
        ring,
      }),
    );
    const other = createKeyring({ rootKey: ring.rootKey, keyVersion: ring.keyVersion });
    const envelope = encryptEnvelope({
      recordId: "sync_2",
      entityType: "memory",
      sourceDeviceId: "dev_ok",
      plaintext: "ok",
      ring: other,
    });
    envelope.sourceDeviceId = "dev_lost";
    envelope.aad = `sync_2|dev_lost|${ring.keyVersion}`;
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /revoked/);
  });

  it("key rotation produces a new version", () => {
    const first = createKeyring();
    const second = rotateKeyring(first);
    assert.equal(second.keyVersion, first.keyVersion + 1);
    assert.notEqual(second.rootKey.equals(first.rootKey), true);
  });

  it("rotated keyring decrypts envelopes from previous versions", () => {
    const first = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_old",
      entityType: "memory",
      sourceDeviceId: "dev_a",
      plaintext: "legacy-envelope",
      ring: first,
    });
    const rotated = rotateKeyring(first);
    const result = decryptEnvelope(envelope, rotated);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.plaintext.toString("utf8"), "legacy-envelope");
  });

  it("unknown key versions fail honestly", () => {
    const ring = createKeyring();
    const envelope = encryptEnvelope({
      recordId: "sync_1",
      entityType: "memory",
      sourceDeviceId: "dev_a",
      plaintext: "x",
      ring,
    });
    envelope.keyVersion = 99;
    envelope.aad = `sync_1|dev_a|99`;
    const result = decryptEnvelope(envelope, ring);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown key version/);
  });

  it("serialize/restore round-trips previous keys and revocations", () => {
    const first = createKeyring();
    revokeDevice(first, "dev_lost");
    const rotated = rotateKeyring(first);
    const restored = restoreKeyring(serializeKeyring(rotated));
    assert.ok(restored);
    assert.equal(restored.keyVersion, rotated.keyVersion);
    assert.equal(restored.revokedDeviceIds.has("dev_lost"), true);
    assert.equal(restored.previous.length, 1);
  });
});
