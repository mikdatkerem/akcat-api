import type { AppContext, AppBindings } from "../types";
import { forbidden, unavailable } from "./errors";

export function allowedOrigins(env: AppBindings): string[] {
  const entries = (env.AUTH_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) throw unavailable();
  for (const entry of entries) {
    let url: URL;
    try { url = new URL(entry); } catch { throw unavailable(); }
    if (entry !== url.origin || !["http:", "https:"].includes(url.protocol)) throw unavailable();
    if (url.protocol !== "https:" && !(env.AUTH_INSECURE_LOCAL_COOKIE === "true" && isLoopback(url))) throw unavailable();
  }
  return entries;
}

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function cookiePolicy(c: AppContext) {
  const url = new URL(c.req.url);
  const local = c.env.AUTH_INSECURE_LOCAL_COOKIE === "true" && url.protocol === "http:" && isLoopback(url);
  if (!local && url.protocol !== "https:") throw unavailable();
  return {
    name: local ? "akcat_session_dev" : "__Host-akcat_session",
    options: { httpOnly: true, secure: !local, sameSite: "Lax" as const, path: "/" },
  };
}

export function requireTrustedOrigin(c: AppContext): void {
  const origin = c.req.header("Origin");
  if (!origin || !allowedOrigins(c.env).includes(origin)) throw forbidden();
}
