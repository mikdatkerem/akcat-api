
import { fromHono } from "chanfana";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { AuthError } from "./auth/errors";
import { Login, Logout, Me } from "./auth/endpoints";
import { authBoundary, authenticate, loginIpLimit, loginOrigin, requireCsrf } from "./auth/middleware";

const app = new Hono<AppEnv>();

// OpenAPI yapılandırması
const openapi = fromHono(app, {
  docs_url: "/",
});

app.onError((error, c) => {
  c.header("Cache-Control", "no-store");
  if (error instanceof AuthError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  // Never log request bodies, cookies, tokens, SQL or raw exception objects.
  console.error("Unhandled API request error");
  return c.json({ error: { code: "INTERNAL_ERROR", message: "İstek işlenemedi." } }, 500);
});

app.use("/api/v1/auth/*", authBoundary);
app.use("/api/v1/auth/*", bodyLimit({ maxSize: 4096,
  onError: (c) => c.json({ error: { code: "BODY_TOO_LARGE", message: "İstek boyutu sınırı aşıldı." } }, 413),
}));
app.use("/api/v1/auth/login", loginOrigin, loginIpLimit);
app.use("/api/v1/auth/me", authenticate);
app.use("/api/v1/auth/logout", authenticate, requireCsrf);
openapi.post("/api/v1/auth/login", Login);
openapi.get("/api/v1/auth/me", Me);
openapi.post("/api/v1/auth/logout", Logout);

// D1 veritabanı sağlık kontrolü
app.get("/api/health", async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "SELECT 1 AS connected"
    ).first<{ connected: number }>();

    if (result?.connected !== 1) {
      return c.json(
        {
          status: "error",
          database: "disconnected",
        },
        503
      );
    }

    return c.json({
      status: "ok",
      database: "connected",
    });
  } catch {
    console.error("Database health check failed");

    return c.json(
      {
        status: "error",
        database: "disconnected",
      },
      503
    );
  }
});

export default app;
