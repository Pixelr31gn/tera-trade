import { describe, expect, it } from "vitest";
import { issueLicenseKey, verifyLicenseKey } from "../src/core/license.js";

const SECRET = "test-secret-not-the-real-default";

describe("license key issue/verify", () => {
  it("accepts a validly issued key for the licensee it was issued to", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }, SECRET);
    const result = verifyLicenseKey(key, "Jane Doe", SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects a key signed with a different secret", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }, SECRET);
    const result = verifyLicenseKey(key, "Jane Doe", "wrong-secret");
    expect(result.valid).toBe(false);
  });

  it("rejects a valid key presented under the wrong licensee name", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }, SECRET);
    const result = verifyLicenseKey(key, "Someone Else", SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects a tampered payload even with a structurally valid signature format", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }, SECRET);
    const [payloadB64, signature] = key.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }) + "x").toString(
      "base64url"
    );
    const tampered = `${tamperedPayload}.${signature}`;
    const result = verifyLicenseKey(tampered, "Jane Doe", SECRET);
    expect(result.valid).toBe(false);
  });

  it("rejects malformed keys instead of throwing", () => {
    expect(verifyLicenseKey("not-a-real-key", "Jane Doe", SECRET).valid).toBe(false);
    expect(verifyLicenseKey("", "Jane Doe", SECRET).valid).toBe(false);
  });

  it("rejects an expired key", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-06-01T00:00:00.000Z" }, SECRET);
    const result = verifyLicenseKey(key, "Jane Doe", SECRET);
    expect(result.valid).toBe(false);
  });

  it("accepts a key with a future expiry", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" }, SECRET);
    const result = verifyLicenseKey(key, "Jane Doe", SECRET);
    expect(result.valid).toBe(true);
  });

  it("accepts a key with no expiry at all", () => {
    const key = issueLicenseKey({ licensedTo: "Jane Doe", issuedAt: new Date().toISOString(), expiresAt: null }, SECRET);
    const result = verifyLicenseKey(key, "Jane Doe", SECRET);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload.expiresAt).toBeNull();
  });
});
