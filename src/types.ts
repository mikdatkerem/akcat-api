import type { Context } from "hono";

export type Role = "admin" | "employee";
export type PublicUser = { id: string; username: string; role: Role };
export type AuthSession = {
  user: PublicUser;
  id: string;
  token: string;
  expiresAt: string;
  transport: "cookie" | "bearer";
};
export type AppBindings = {
  DB: D1Database;
  AUTH_IP_RATE_LIMITER: RateLimit;
  AUTH_ACCOUNT_RATE_LIMITER: RateLimit;
  AUTH_ALLOWED_ORIGINS?: string;
  AUTH_INSECURE_LOCAL_COOKIE?: string;
  AUTH_ENABLE_MOBILE_BEARER?: string;
};
export type AppEnv = { Bindings: AppBindings; Variables: { auth: AuthSession } };
export type AppContext = Context<AppEnv>;
