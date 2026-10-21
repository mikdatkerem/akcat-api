import { OpenAPIRoute } from "chanfana";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppContext, Role } from "../types";
import { verifyPassword } from "../security/password";
import { csrfToken, newWebToken, tokenHash } from "../security/tokens";
import { cookiePolicy } from "./config";
import { AuthError, invalidLogin } from "./errors";
import { checkRateLimit } from "./middleware";
import { loginSchema, sessionResponseSchema } from "./schemas";

const response = (schema: z.ZodType) => ({ description: "Başarılı", content: { "application/json": { schema } } });
const SESSION_SECONDS = 8 * 60 * 60;

export class Login extends OpenAPIRoute {
  schema = {
    tags: ["Auth"], summary: "Web oturumu aç", security: [],
    request: { body: { required: true, content: { "application/json": { schema: loginSchema } } } },
    responses: { "200": response(sessionResponseSchema) },
  };
  async handle(c: AppContext) {
    let input: z.infer<typeof loginSchema>;
    try { input = (await this.getValidatedData<typeof this.schema>()).body; }
    catch { throw new AuthError(400, "INVALID_INPUT", "Kullanıcı adı ve parola geçerli biçimde gönderilmeli."); }
    await checkRateLimit(c, "account", input.username);
    const db = c.env.DB.withSession("first-primary");
    const user = await db.prepare("SELECT id, username, password_hash, role, is_active FROM users WHERE username = ?")
      .bind(input.username).first<{ id: string; username: string; password_hash: string; role: Role; is_active: number }>();
    const verified = await verifyPassword(input.password, user?.password_hash);
    if (!verified || !user || user.is_active !== 1) throw invalidLogin();
    const token = newWebToken();
    const id = tokenHash(token);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
    const results = await db.batch([
      db.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at)
        SELECT ?, id, ?, ? FROM users WHERE id = ? AND is_active = 1 AND password_hash = ?`)
        .bind(id, expiresAt, now, user.id, user.password_hash),
      db.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, created_at)
        SELECT ?, user_id, 'auth.login', 'session', ?, ? FROM sessions WHERE id = ?`)
        .bind(crypto.randomUUID(), id, now, id),
    ]);
    if (results[0]?.meta.changes !== 1) throw invalidLogin();
    const current = await db.prepare("SELECT id, username, role FROM users WHERE id = ? AND is_active = 1")
      .bind(user.id).first<{ id: string; username: string; role: Role }>();
    if (!current) throw invalidLogin();
    const policy = cookiePolicy(c);
    setCookie(c, policy.name, token, { ...policy.options, maxAge: SESSION_SECONDS, expires: new Date(expiresAt) });
    return c.json({ user: current, expiresAt, csrfToken: csrfToken(token) });
  }
}

export class Me extends OpenAPIRoute {
  schema = { tags: ["Auth"], summary: "Güncel kullanıcı ve oturum", responses: { "200": response(sessionResponseSchema) } };
  async handle(c: AppContext) {
    const auth = c.get("auth");
    return c.json({ user: auth.user, expiresAt: auth.expiresAt,
      ...(auth.transport === "cookie" ? { csrfToken: csrfToken(auth.token) } : {}) });
  }
}

export class Logout extends OpenAPIRoute {
  schema = { tags: ["Auth"], summary: "Geçerli oturumu iptal et", responses: { "200": response(z.object({ success: z.literal(true) })) } };
  async handle(c: AppContext) {
    const auth = c.get("auth");
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, auth.id),
      c.env.DB.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, created_at)
        VALUES (?, ?, 'auth.logout', 'session', ?, ?)`).bind(crypto.randomUUID(), auth.user.id, auth.id, now),
    ]);
    if (auth.transport === "cookie") {
      const policy = cookiePolicy(c);
      deleteCookie(c, policy.name, policy.options);
    }
    return c.json({ success: true });
  }
}
