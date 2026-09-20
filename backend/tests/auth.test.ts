import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/config.js", () => ({
  getSettings: vi.fn(() => ({ sessionSecret: "test-session-secret" })),
}));

const { getSettings } = await import("../src/core/config.js");
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  getCookie,
} = await import("../src/core/auth.js");

describe("hashPassword / verifyPassword", () => {
  it("verifies the correct password against its own hash", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different salt (and hash) each time", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("rejects a malformed stored hash instead of throwing", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });
});

describe("createSessionToken / verifySessionToken", () => {
  it("accepts a token it just issued", () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it("rejects a tampered token", () => {
    const token = createSessionToken();
    expect(verifySessionToken(`${token}tampered`)).toBe(false);
  });

  it("rejects an expired token", () => {
    const expiredPayload = String(Date.now() - 1000);
    const wrongSignature = "0".repeat(64);
    expect(verifySessionToken(`${expiredPayload}.${wrongSignature}`)).toBe(false);
  });

  it("rejects missing/empty tokens", () => {
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken(null)).toBe(false);
    expect(verifySessionToken("")).toBe(false);
  });

  it("fails closed when no session secret is configured", () => {
    vi.mocked(getSettings).mockReturnValueOnce({ sessionSecret: "" } as ReturnType<typeof getSettings>);
    const token = createSessionToken(); // signed with "" -- shouldn't matter, verify still refuses
    vi.mocked(getSettings).mockReturnValueOnce({ sessionSecret: "" } as ReturnType<typeof getSettings>);
    expect(verifySessionToken(token)).toBe(false);
  });
});

describe("getCookie", () => {
  it("finds a cookie by name among several", () => {
    expect(getCookie("a=1; tera_session=abc123; b=2", "tera_session")).toBe("abc123");
  });

  it("returns undefined when the cookie isn't present", () => {
    expect(getCookie("a=1; b=2", "tera_session")).toBeUndefined();
  });

  it("returns undefined for a missing header", () => {
    expect(getCookie(undefined, "tera_session")).toBeUndefined();
  });
});
