// This entry point is used ONLY by tests/wrangler.jsonc. Never import it from production.
import { Hono } from "hono";
import app from "../src/index";
import { authenticate, requireRole } from "../src/auth/middleware";
import { bootstrapAdmin, BootstrapUnavailable } from "../src/auth/bootstrap";
import { AuthError } from "../src/auth/errors";
import type { AppEnv, AppBindings } from "../src/types";

type TestBindings = AppBindings & { TEST_KEY: string };
const harness = new Hono<{ Bindings: TestBindings }>();
const admin = new Hono<AppEnv>();
admin.onError((error, c) => error instanceof AuthError
  ? c.json({ error: { code: error.code, message: error.message } }, error.status)
  : c.json({ error: "test route failure" }, 500));
admin.use("*", authenticate, requireRole("admin"));
admin.get("*", (c) => c.json({ allowed: true }));

harness.use("*", async (c, next) => {
  if (!c.env.TEST_KEY || c.req.header("X-Test-Key") !== c.env.TEST_KEY) return c.json({ error: "test key required" }, 403);
  await next();
});
harness.post("/__test/schema", async (c) => {
  const { sql } = await c.req.json<{ sql: string }>();
  const statements = sql.split(";").map((value) => value.trim()).filter(Boolean);
  await c.env.DB.batch(statements.map((value) => c.env.DB.prepare(value)));
  return c.json({ ok: true });
});
harness.post("/__test/sql", async (c) => {
  const { sql, params = [] } = await c.req.json<{ sql: string; params: (string | number | null)[] }>();
  return c.json(await c.env.DB.prepare(sql).bind(...params).all());
});
harness.post("/__test/bootstrap", async (c) => {
  try {
    await bootstrapAdmin((batch) => c.env.DB.batch(batch.map(({ sql, params }) => c.env.DB.prepare(sql).bind(...params))), await c.req.json());
    return c.json({ ok: true }, 201);
  } catch (error) {
    return c.json({ error: error instanceof BootstrapUnavailable ? "unavailable" : "failed" }, 409);
  }
});
harness.all("*", (c) => {
  const url = new URL(c.req.url);
  const mode = c.req.header("X-Test-Mode");
  const env = { ...c.env };
  if (mode === "secure") {
    url.protocol = "https:";
    url.host = "api.akcat.test";
    env.AUTH_ALLOWED_ORIGINS = "https://app.akcat.test";
    env.AUTH_INSECURE_LOCAL_COOKIE = "false";
  }
  if (mode === "bearer") env.AUTH_ENABLE_MOBILE_BEARER = "true";
  if (mode === "unconfigured") env.AUTH_ALLOWED_ORIGINS = "";
  if (mode === "insecure-public") url.host = "api.akcat.test";
  if (mode === "no-rate-binding") env.AUTH_IP_RATE_LIMITER = undefined as unknown as RateLimit;
  const headers = new Headers(c.req.raw.headers);
  headers.set("CF-Connecting-IP", c.req.header("X-Test-IP") ?? crypto.randomUUID());
  const request = new Request(url, c.req.raw);
  const forwarded = new Request(request, { headers });
  if (url.pathname === "/__test/admin") return admin.fetch(forwarded, env, c.executionCtx);
  return app.fetch(forwarded, env, c.executionCtx);
});

export default harness;
