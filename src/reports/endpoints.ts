import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError } from "../auth/errors";
import { reportQuery, summaryQuery, paymentsQuery, currentDebtQuery, employeesQuery, summaryReportSchema, salesReportSchema, paymentReportSchema, debtReportSchema, employeeReportSchema } from "./schemas";
import { reportSummary, reportSales, reportPayments, reportReceivables, reportEmployees } from "./repository";
const response = <S extends z.ZodType>(schema: S) => ({ "200": { description: "Gerçek finansal rapor", content: { "application/json": { schema } } } });
const invalid = () => new AuthError(400, "INVALID_REPORT_INPUT", "Dönemi, tarih aralığını, aramayı ve sayfalamayı kontrol edin.");
export class SummaryReport extends OpenAPIRoute {
  schema = { tags: ["Reports"], summary: "Dönem satış/tahsilat, güncel borç ve son işlemler", request: { query: summaryQuery }, responses: response(summaryReportSchema) };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await reportSummary(c.env.DB, query)); }
}
export class SalesReport extends OpenAPIRoute {
  schema = { tags: ["Reports"], summary: "Satış, ayrı iptal, kalem ve tarihsel ürün raporu", request: { query: reportQuery }, responses: response(salesReportSchema) };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await reportSales(c.env.DB, query)); }
}
export class PaymentsReport extends OpenAPIRoute {
  schema = { tags: ["Reports"], summary: "Geçerli nakit/kart/banka tahsilat raporu", request: { query: paymentsQuery }, responses: response(paymentReportSchema) };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await reportPayments(c.env.DB, query)); }
}
export class ReceivablesReport extends OpenAPIRoute {
  schema = { tags: ["Reports"], summary: "Dönemden bağımsız güncel açık borç raporu", request: { query: currentDebtQuery }, responses: response(debtReportSchema) };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await reportReceivables(c.env.DB, query)); }
}
export class EmployeesReport extends OpenAPIRoute {
  schema = { tags: ["Reports"], summary: "Admin çalışan bazlı satış ve gerçek tahsil eden raporu", request: { query: employeesQuery }, responses: response(employeeReportSchema) };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await reportEmployees(c.env.DB, query)); }
}
