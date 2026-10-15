/**
 * App-lock PIN verifier: PBKDF2-SHA-256, 600 000 iterations, 16-byte random salt, 32-byte
 * output (WebCrypto via node:crypto). Only the verifier is stored, and the app stores it
 * encrypted with the OS (safeStorage). Comparison is constant-time.
 *
 * Plus the brute-force back-off for the lock screen.
 */
import { randomBytes, timingSafeEqual, webcrypto } from "node:crypto";

export const PIN_ITERATIONS = 600_000;
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 64;

export interface PinVerifier {
  v: 1;
  alg: "PBKDF2-SHA-256";
  iterations: number;
  salt: string; // base64
  hash: string; // base64
}

export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string") return "Enter a PIN.";
  if (pin.length < PIN_MIN_LENGTH) return `Use at least ${PIN_MIN_LENGTH} characters.`;
  if (pin.length > PIN_MAX_LENGTH) return `Use at most ${PIN_MAX_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pin)) return "The PIN contains characters that can't be typed.";
  return null;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<Buffer> {
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(pin.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return Buffer.from(bits);
}

export async function createPinVerifier(pin: string, iterations = PIN_ITERATIONS): Promise<PinVerifier> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const hash = await derive(pin, salt, iterations);
  return { v: 1, alg: "PBKDF2-SHA-256", iterations, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function parsePinVerifier(raw: unknown): PinVerifier | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.alg !== "PBKDF2-SHA-256") return null;
  if (typeof r.iterations !== "number" || !Number.isInteger(r.iterations) || r.iterations < 100_000 || r.iterations > 10_000_000) return null;
  if (typeof r.salt !== "string" || typeof r.hash !== "string") return null;
  if (Buffer.from(r.salt, "base64").length < 16 || Buffer.from(r.hash, "base64").length !== 32) return null;
  return { v: 1, alg: "PBKDF2-SHA-256", iterations: r.iterations, salt: r.salt, hash: r.hash };
}

export async function verifyPin(pin: string, v: PinVerifier): Promise<boolean> {
  if (typeof pin !== "string" || pin.length === 0 || pin.length > PIN_MAX_LENGTH) return false;
  const got = await derive(pin, Buffer.from(v.salt, "base64"), v.iterations);
  const want = Buffer.from(v.hash, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Lock-screen back-off: the first 5 wrong PINs are free, then each further failure doubles
 * the wait, from 30 s up to 15 min. Returns the delay (ms) before the next attempt is allowed.
 */
export function backoffMs(failures: number): number {
  if (failures < 5) return 0;
  return Math.min(30_000 * 2 ** (failures - 5), 15 * 60_000);
}
