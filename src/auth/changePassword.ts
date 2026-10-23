import { OpenAPIRoute } from "chanfana";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext, AppEnv } from "../types";
import type { MiddlewareHandler } from "hono";
import { hashPassword, verifyPassword } from "../security/password";
import { tokenHash } from "../security/tokens";
import { cookiePolicy } from "./config";
import { AuthError, unavailable } from "./errors";
import { changePasswordSchema } from "./schemas";

// Separate key space from login; the existing account limiter policy also limits password guesses.
export const passwordChangeLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "POST") return next();
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  const limiter = c.env.AUTH_ACCOUNT_RATE_LIMITER;
  if (!limiter) throw unavailable();
  let success: boolean;
  try { ({ success } = await limiter.limit({ key: `akcat:password-change:${tokenHash(c.get("auth").user.id)}` })); }
  catch { throw unavailable(); }
  if (!success) {
    c.header("Retry-After", "60");
    throw new AuthError(429, "PASSWORD_CHANGE_RATE_LIMITED", "Çok fazla parola değiştirme denemesi. Bir dakika sonra tekrar deneyin.");
  }
  await next();
};

export class ChangePassword extends OpenAPIRoute {
  schema = {
    tags: ["Auth"], summary: "Kendi parolanı değiştir ve tüm oturumlarını kapat",
    request: { body: { required: true, content: { "application/json": { schema: changePasswordSchema } } } },
    responses: { "200": { description: "Parola değiştirildi; yeniden giriş gerekli", content: {
      "application/json": { schema: z.object({ success: z.literal(true) }) },
    } } },
  };
  async handle(c: AppContext) {
    let input: z.infer<typeof changePasswordSchema>;
    try { input = (await this.getValidatedData<typeof this.schema>()).body; }
    catch { throw new AuthError(400, "INVALID_PASSWORD_INPUT", "Mevcut parolayı ve 15–128 karakterlik yeni parolayı kontrol edin."); }
    const auth = c.get("auth"), db = c.env.DB.withSession("first-primary");
    const user = await db.prepare("SELECT password_hash FROM users WHERE id = ? AND is_active = 1")
      .bind(auth.user.id).first<{ password_hash: string }>();
    if (!(await verifyPassword(input.current_password, user?.password_hash)) || !user) {
      // An incorrect password does not invalidate an otherwise valid session (not HTTP 401).
      throw new AuthError(400, "CURRENT_PASSWORD_INVALID", "Mevcut parolanız hatalı.");
    }
    if (input.current_password === input.new_password) {
      throw new AuthError(400, "PASSWORD_UNCHANGED", "Yeni parola mevcut parolanızdan farklı olmalı.");
    }
    const hash = await hashPassword(input.new_password);
    const now = new Date().toISOString(), audit = crypto.randomUUID();
    // The audit marker gates both writes. D1 batch rolls everything back if any statement fails.
    // Recheck the verified hash AND live session after the slow KDF: a concurrent reset, logout,
    // deactivation or password change cannot be overwritten by a stale verification.
    const result = await db.batch([
      db.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, created_at)
        SELECT ?, u.id, 'auth.password_changed', 'user', u.id, ? FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE u.id = ? AND u.is_active = 1 AND u.password_hash = ?
          AND s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`)
        .bind(audit, now, auth.user.id, user.password_hash, auth.id, now),
      db.prepare(`UPDATE users SET password_hash = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`)
        .bind(hash, now, auth.user.id, audit),
      db.prepare(`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`)
        .bind(now, auth.user.id, audit),
    ]);
    if (result[0]?.meta.changes !== 1) {
      throw new AuthError(409, "PASSWORD_CHANGE_CONFLICT", "Hesap veya oturum bu sırada değişti. Oturumunuzu kontrol edip yeniden deneyin.");
    }
    if (auth.transport === "cookie") {
      const policy = cookiePolicy(c);
      deleteCookie(c, policy.name, policy.options);
    }
    return c.json({ success: true });
  }
}
