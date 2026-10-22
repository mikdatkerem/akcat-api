import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { AppEnv, AppContext, Role } from "../types";
import { csrfToken, matchesSecret, MOBILE_TOKEN, tokenHash, WEB_TOKEN } from "../security/tokens";
import { allowedOrigins, cookiePolicy, requireTrustedOrigin } from "./config";
import { AuthError, forbidden, unauthorized, unavailable } from "./errors";

export function apiBoundary(allowMethods: string[], extraHeaders: string[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
  cookiePolicy(c); // HTTPS is required for all auth transports outside explicit loopback development.
  const origins = allowedOrigins(c.env);
  const origin = c.req.header("Origin");
  if (origin && !origins.includes(origin)) throw forbidden();
  return cors({
    origin: (value) => origins.includes(value) ? value : undefined,
    credentials: true,
    allowMethods,
    allowHeaders: ["Content-Type", "X-CSRF-Token", "Authorization", ...extraHeaders],
    maxAge: 600,
  })(c, next);
  };
}
export const authBoundary = apiBoundary(["GET", "POST", "OPTIONS"]);

export const loginOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireTrustedOrigin(c);
  cookiePolicy(c);
  // JSON is not a CORS-safelisted content type: prevents form/login CSRF before a session exists.
  if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  await next();
};

export async function checkRateLimit(c: AppContext, kind: "ip" | "account", identity: string): Promise<void> {
  const binding = kind === "ip" ? c.env.AUTH_IP_RATE_LIMITER : c.env.AUTH_ACCOUNT_RATE_LIMITER;
  if (!binding) throw unavailable();
  let success: boolean;
  try { ({ success } = await binding.limit({ key: `akcat:login:${kind}:${tokenHash(identity)}` })); }
  catch { throw unavailable(); }
  if (!success) {
    c.header("Retry-After", "60");
    throw new AuthError(429, "RATE_LIMITED", "Çok fazla giriş denemesi. Daha sonra tekrar deneyin.");
  }
}

export const loginIpLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Only Cloudflare's overwritten client-IP header is trusted; never X-Forwarded-For.
  await checkRateLimit(c, "ip", c.req.header("CF-Connecting-IP") ?? "unknown");
  await next();
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const policy = cookiePolicy(c);
  const cookies = (c.req.header("Cookie") ?? "").split(";").map((value) => value.trim())
    .filter((value) => /^(?:__Host-akcat_session|akcat_session_dev)=/.test(value));
  const authorization = c.req.header("Authorization");
  if (cookies.length > 1 || (cookies.length && authorization)) throw unauthorized();
  let token: string;
  let transport: "cookie" | "bearer";
  if (authorization) {
    if (c.env.AUTH_ENABLE_MOBILE_BEARER !== "true" || !/^Bearer m1_[A-Za-z0-9_-]{43}$/.test(authorization)) throw unauthorized();
    token = authorization.slice(7);
    if (!MOBILE_TOKEN.test(token)) throw unauthorized();
    transport = "bearer";
  } else {
    const { name } = policy;
    const cookie = cookies[0];
    if (!cookie?.startsWith(`${name}=`)) throw unauthorized();
    token = cookie.slice(name.length + 1);
    if (!WEB_TOKEN.test(token)) throw unauthorized();
    transport = "cookie";
  }
  const id = tokenHash(token);
  // Primary read ensures revocations, deactivation and role changes are applied on the next request.
  const row = await c.env.DB.withSession("first-primary").prepare(`
    SELECT u.id, u.username, u.role, u.is_active, s.expires_at, s.revoked_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?
  `).bind(id).first<{ id: string; username: string; role: Role; is_active: number; expires_at: string; revoked_at: string | null }>();
  if (!row || row.revoked_at || row.is_active !== 1 || !["admin", "employee"].includes(row.role)
    || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()) throw unauthorized();
  c.set("auth", { id, token, transport, expiresAt: row.expires_at,
    user: { id: row.id, username: row.username, role: row.role } });
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw unauthorized();
    if (!roles.includes(auth.user.role)) throw forbidden();
    await next();
  };
}

// Mount after authenticate on ALL future cookie-authenticated mutation routes.
export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) throw unauthorized();
  if (auth.transport === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    requireTrustedOrigin(c);
    if (!matchesSecret(c.req.header("X-CSRF-Token") ?? "", csrfToken(auth.token))) throw forbidden();
  }
  await next();
};
