import { beforeEach, describe, expect, it } from "vitest";
import { generatePickleKey, randomSecret, seal, unseal } from "../../src/lib/session-crypto";
import { clearSession, hasStoredSession, loadSession, saveSession, SESSION_LS_KEY, SessionUnavailableError } from "../../src/lib/session-store";
import { deleteDb } from "../../src/lib/idb";

describe("session encryption at rest", () => {
  it("round-trips a secret", async () => {
    const key = await generatePickleKey();
    const sealed = await seal(key, "syt_secret_token", "ctx");
    // The ciphertext must not contain the plaintext. (Checking for a single byte value, as this
    // test once did, fails about 1 run in 8: random ciphertext contains any given byte that often.)
    const ct = Buffer.from(new Uint8Array(sealed.ct));
    expect(ct.includes(Buffer.from("syt_secret_token"))).toBe(false);
    expect(ct.includes(Buffer.from("secret"))).toBe(false);
    expect(ct.length).toBe("syt_secret_token".length + 16); // AES-GCM: same length plus the 16-byte tag
    expect(await unseal(key, sealed, "ctx")).toBe("syt_secret_token");
  });

  it("generates a non-extractable key", async () => {
    const key = await generatePickleKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("detects tampering and wrong context", async () => {
    const key = await generatePickleKey();
    const sealed = await seal(key, "token", "user-a|DEV1");
    const ct = new Uint8Array(sealed.ct.slice(0));
    ct[0] ^= 1;
    await expect(unseal(key, { ...sealed, ct: ct.buffer }, "user-a|DEV1")).rejects.toThrow();
    await expect(unseal(key, sealed, "user-b|DEV1")).rejects.toThrow();
    const other = await generatePickleKey();
    await expect(unseal(other, sealed, "user-a|DEV1")).rejects.toThrow();
  });

  it("uses a fresh IV every time", async () => {
    const key = await generatePickleKey();
    const a = await seal(key, "same", "c");
    const b = await seal(key, "same", "c");
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
  });

  it("makes random secrets", () => {
    const s = randomSecret(32);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomSecret()).not.toBe(s);
  });
});

describe("session store", () => {
  beforeEach(async () => {
    localStorage.clear();
    await deleteDb("lumen-session");
  });

  it("stores only non-secret metadata in localStorage", async () => {
    const s = await saveSession({ userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" }, "syt_very_secret");
    expect(s.storagePassword.length).toBeGreaterThan(30);
    const ls = localStorage.getItem(SESSION_LS_KEY)!;
    expect(JSON.parse(ls)).toEqual({ v: 1, userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" });
    expect(ls).not.toContain("syt_very_secret");
    expect(ls).not.toContain(s.storagePassword);
    expect(hasStoredSession()).toBe(true);
  });

  it("loads the session back (token and crypto-store password)", async () => {
    const saved = await saveSession({ userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" }, "syt_tok");
    const loaded = await loadSession();
    expect(loaded).toEqual(saved);
  });

  it("returns null without a session and fails clearly if the keys are gone", async () => {
    expect(await loadSession()).toBeNull();
    await saveSession({ userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" }, "tok");
    await deleteDb("lumen-session");
    await expect(loadSession()).rejects.toBeInstanceOf(SessionUnavailableError);
  });

  it("clears everything", async () => {
    await saveSession({ userId: "@a:x", deviceId: "DEV", homeserverUrl: "https://m.x" }, "tok");
    await clearSession();
    expect(hasStoredSession()).toBe(false);
    expect(await loadSession()).toBeNull();
  });
});
