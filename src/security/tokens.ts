import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEB_TOKEN = /^w1_[A-Za-z0-9_-]{43}$/;
export const MOBILE_TOKEN = /^m1_[A-Za-z0-9_-]{43}$/;
export const newWebToken = () => `w1_${randomBytes(32).toString("base64url")}`;
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const csrfToken = (token: string) => createHmac("sha256", token)
  .update("akcat:web-csrf:v1").digest("base64url");

export function matchesSecret(actual: string, expected: string): boolean {
  // Hashing first makes the comparison fixed length, including malformed input.
  return timingSafeEqual(Buffer.from(tokenHash(actual), "hex"), Buffer.from(tokenHash(expected), "hex"));
}
