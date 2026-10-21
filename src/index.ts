
import { fromHono } from "chanfana";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// OpenAPI yapılandırması
fromHono(app, {
  docs_url: "/",
});

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
  } catch (error) {
    console.error("Database health check failed", error);

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
