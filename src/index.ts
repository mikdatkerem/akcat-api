import { AdjustmentList } from "./finance/adjustments";

import { fromHono } from "chanfana";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./types";
import { AuthError } from "./auth/errors";
import { Login, Logout, Me } from "./auth/endpoints";
import { apiBoundary, authBoundary, authenticate, loginIpLimit, loginOrigin, requireCsrf, requireRole } from "./auth/middleware";
import { CustomerList, CustomerGet, CustomerCreate, CustomerPatch } from "./customers/endpoints";
import { ProductList, ProductGet, ProductCreate, ProductPatch } from "./products/endpoints";
import { SaleCreate, SaleList, SaleGet } from "./sales/endpoints";
import { PaymentCreate, PaymentList, ReceivableList, CustomerLedger, CustomerReceivables } from "./finance/endpoints";
import { SaleCancel, CorrectionCreate, CorrectionList, CorrectionGet, CorrectionApprove, CorrectionReject } from "./corrections/endpoints";
import { SummaryReport, SalesReport, PaymentsReport, ReceivablesReport, EmployeesReport } from "./reports/endpoints";

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

const customerSecurity = [apiBoundary(["GET", "POST", "PATCH", "OPTIONS"], ["Idempotency-Key"]),
  authenticate, requireRole("admin", "employee"), requireCsrf] as const;
app.use("/api/v1/customers", ...customerSecurity);
app.use("/api/v1/customers/*", ...customerSecurity);
const customerBodyLimit = bodyLimit({ maxSize: 16384,
  onError: c => c.json({ error: { code: "BODY_TOO_LARGE", message: "İstek boyutu sınırı aşıldı." } }, 413),
});
app.use("/api/v1/customers", customerBodyLimit);
app.use("/api/v1/customers/*", customerBodyLimit);
// JSON writes only; CSRF and exact-origin checks stay active for cookie clients.
app.use("/api/v1/customers", async (c, next) => {
  if (c.req.method === "POST" && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  await next();
});
app.use("/api/v1/customers/*", async (c, next) => {
  if (c.req.method === "PATCH" && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  await next();
});
openapi.get("/api/v1/customers", CustomerList);
openapi.post("/api/v1/customers", CustomerCreate);
openapi.get("/api/v1/customers/:id", CustomerGet);
openapi.patch("/api/v1/customers/:id", CustomerPatch);

const productSecurity = [apiBoundary(["GET", "POST", "PATCH", "OPTIONS"], ["Idempotency-Key"]),
  authenticate, requireRole("admin", "employee"), requireCsrf] as const;
app.use("/api/v1/products", ...productSecurity);
app.use("/api/v1/products/*", ...productSecurity);
app.use("/api/v1/products", customerBodyLimit);
app.use("/api/v1/products/*", customerBodyLimit);
app.use("/api/v1/products", async (c, next) => {
  if (c.req.method === "POST") {
    await requireRole("admin")(c, async () => {});
    if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
    }
  }
  await next();
});
app.use("/api/v1/products/*", async (c, next) => {
  if (c.req.method === "PATCH") {
    await requireRole("admin")(c, async () => {});
    if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
    }
  }
  await next();
});
openapi.get("/api/v1/products", ProductList);
openapi.post("/api/v1/products", ProductCreate);
openapi.get("/api/v1/products/:id", ProductGet);
openapi.patch("/api/v1/products/:id", ProductPatch);

const saleSecurity = [apiBoundary(["GET", "POST", "OPTIONS"], ["Idempotency-Key"]),
  authenticate, requireRole("admin", "employee"), requireCsrf] as const;
app.use("/api/v1/sales", ...saleSecurity);
app.use("/api/v1/sales/*", ...saleSecurity);
app.use("/api/v1/sales", customerBodyLimit);
app.use("/api/v1/sales", async (c, next) => {
  if (c.req.method === "POST" && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  await next();
});
openapi.post("/api/v1/sales", SaleCreate);
openapi.get("/api/v1/sales", SaleList);
openapi.get("/api/v1/sales/:id", SaleGet);
app.use("/api/v1/sales/*", customerBodyLimit);
app.use("/api/v1/sales/*", async (c, next) => {
  if (c.req.method === "POST" && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  await next();
});
openapi.post("/api/v1/sales/:id/cancel", SaleCancel);

const correctionSecurity = [apiBoundary(["GET", "POST", "OPTIONS"], ["Idempotency-Key"]), authenticate, requireRole("admin", "employee"), requireCsrf, customerBodyLimit] as const;
app.use("/api/v1/correction-requests", ...correctionSecurity);
app.use("/api/v1/correction-requests/*", ...correctionSecurity);
const correctionWrite = async (c: import("./types").AppContext, next: () => Promise<void>) => {
  if (c.req.method === "POST") {
    if (/\/(approve|reject)$/.test(c.req.path)) await requireRole("admin")(c, async () => {});
    if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  }
  await next();
};
app.use("/api/v1/correction-requests", correctionWrite);
app.use("/api/v1/correction-requests/*", correctionWrite);
openapi.get("/api/v1/correction-requests", CorrectionList);
openapi.post("/api/v1/correction-requests", CorrectionCreate);
openapi.get("/api/v1/correction-requests/:id", CorrectionGet);
openapi.post("/api/v1/correction-requests/:id/approve", CorrectionApprove);
openapi.post("/api/v1/correction-requests/:id/reject", CorrectionReject);

const paymentSecurity = [apiBoundary(["GET", "POST", "OPTIONS"], ["Idempotency-Key"]), authenticate, requireRole("admin", "employee"), requireCsrf] as const;
app.use("/api/v1/payments", ...paymentSecurity);
app.use("/api/v1/payments/*", ...paymentSecurity);
app.use("/api/v1/payments", customerBodyLimit);
app.use("/api/v1/payments", async (c, next) => {
  if (c.req.method === "POST" && c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new AuthError(415, "JSON_REQUIRED", "JSON isteği gerekli.");
  await next();
});
app.use("/api/v1/receivables", apiBoundary(["GET", "OPTIONS"]), authenticate, requireRole("admin", "employee"));
openapi.post("/api/v1/payments", PaymentCreate);
openapi.get("/api/v1/payments", PaymentList);
openapi.get("/api/v1/receivables", ReceivableList);
app.use("/api/v1/financial-adjustments", apiBoundary(["GET", "OPTIONS"]), authenticate, requireRole("admin", "employee"));
openapi.get("/api/v1/financial-adjustments", AdjustmentList);
// Customer security above already covers authenticated GETs on these nested routes.
openapi.get("/api/v1/customers/:id/receivables", CustomerReceivables);
openapi.get("/api/v1/customers/:id/ledger", CustomerLedger);

app.use("/api/v1/reports/*", apiBoundary(["GET", "OPTIONS"]), authenticate, requireRole("admin", "employee"));
app.use("/api/v1/reports/employees", requireRole("admin"));
app.use("/api/v1/reports/*", async (c, next) => {
  // Actor-scoped report aggregates are management drilldowns, even on shared report paths.
  if (c.req.query("created_by") !== undefined) await requireRole("admin")(c, async () => {});
  await next();
});
openapi.get("/api/v1/reports/summary", SummaryReport);
openapi.get("/api/v1/reports/sales", SalesReport);
openapi.get("/api/v1/reports/payments", PaymentsReport);
openapi.get("/api/v1/reports/receivables", ReceivablesReport);
openapi.get("/api/v1/reports/employees", EmployeesReport);

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
