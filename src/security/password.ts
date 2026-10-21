import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP scrypt minimum alternative: 16 MiB, five passes. Keep parameters versioned.
const POLICY = "scrypt:v1:16384:8:5";
const DUMMY_SALT = Buffer.alloc(16, 0x6b);
const DUMMY_DIGEST = Buffer.alloc(32);

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `${POLICY}:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const match = encoded?.match(/^scrypt:v1:16384:8:5:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/);
  const salt = match?.[1] ? Buffer.from(match[1], "base64url") : DUMMY_SALT;
  const expected = match?.[2] ? Buffer.from(match[2], "base64url") : DUMMY_DIGEST;
  // Missing, inactive and malformed accounts still pay the same KDF cost.
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && Boolean(match);
}
