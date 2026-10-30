import { adjustmentTotalsSchema } from "../finance/adjustments";
import { z } from "zod";
import { pagination, pageSchema, paymentSchema } from "../finance/schemas";
import { money, saleSummarySchema } from "../sales/schemas";
const optional = <S extends z.ZodType>(schema: S) => z.preprocess(value => value === null || value === "" ? undefined : value, schema.optional());
export const reportQuery = pagination.extend({
  period: z.enum(["today", "yesterday", "last7", "month", "custom"]).default("today"),
  from: optional(z.iso.date().refine(value => value >= "1900-01-01" && value <= "9998-12-31")),
  to: optional(z.iso.date().refine(value => value >= "1900-01-01" && value <= "9998-12-31")),
  q: z.preprocess(value => value === null ? "" : value, z.string().trim().normalize("NFC").max(100).default("")),
  created_by: optional(z.uuid()),
  view: z.enum(["sales", "cancelled", "items", "products"]).default("sales"),
}).refine(value => value.period === "custom" ? !!value.from && !!value.to && value.from <= value.to : !value.from && !value.to);
export type ReportQuery = z.infer<typeof reportQuery>;
export const summaryQuery = reportQuery.refine(value => !value.q && !value.created_by && value.view === "sales" && value.page === 1 && value.pageSize === 20);
export const paymentsQuery = reportQuery.refine(value => value.view === "sales");
export const currentDebtQuery = reportQuery.refine(value => !value.created_by && value.view === "sales");
export const employeesQuery = reportQuery.refine(value => !value.created_by && value.view === "sales");
export const rangeSchema = z.object({ period: z.string(), from: z.string(), to: z.string(), start_date: z.string(), end_date: z.string(),
  time_zone: z.literal("Europe/Istanbul"), generated_at: z.string() });
export const salesTotalsSchema = z.object({ sales_total_kurus: money, sales_count: money, cancelled_total_kurus: money, cancelled_count: money });
export const paymentTotalsSchema = z.object({ payments_total_kurus: money, payments_count: money, cash_kurus: money, card_kurus: money, bank_kurus: money });
export const debtTotalsSchema = z.object({ total_debt_kurus: money, debtor_count: money, open_sales_count: money, sales_total_kurus: money, paid_kurus: money });
export const recentSchema = z.object({ id: z.string(), type: z.enum(["sale", "payment", "cancellation", "record_reversal", "external_refund"]), sale_id: z.string().nullable(),
  customer_id: z.string().nullable(), customer_name: z.string(), amount_kurus: money, created_by: z.string(), created_by_username: z.string(), created_at: z.string(), status: z.string() });
export const summaryReportSchema = z.object({ range: rangeSchema, sales: salesTotalsSchema, payments: paymentTotalsSchema, adjustments: adjustmentTotalsSchema, receivables: debtTotalsSchema, recent: z.array(recentSchema) });
export const itemSchema = z.object({ id: z.string(), sale_id: z.string(), product_id: z.string(), product_name_snapshot: z.string(), unit_price_kurus: money,
  quantity: money, line_total_kurus: money, created_at: z.string(), created_by_username: z.string(), customer_name: z.string() });
export const productSchema = z.object({ product_id: z.string(), product_name_snapshot: z.string(), unit_price_kurus: money, quantity: money, total_kurus: money });
export const salesReportSchema = z.object({ range: rangeSchema, summary: salesTotalsSchema, view: z.string(), data: z.array(z.union([saleSummarySchema, itemSchema, productSchema])), pagination: pageSchema });
export const paymentReportSchema = z.object({ range: rangeSchema, summary: paymentTotalsSchema, adjustments: adjustmentTotalsSchema, data: z.array(paymentSchema), pagination: pageSchema });
export const debtorSchema = z.object({ id: z.string(), name: z.string(), phone: z.string().nullable(), total_debt_kurus: money, open_sales_count: money,
  sales_total_kurus: money, paid_kurus: money, last_payment_at: z.string().nullable() });
export const debtReportSchema = z.object({ range: rangeSchema, balance_scope: z.literal("current"), summary: debtTotalsSchema, data: z.array(debtorSchema), pagination: pageSchema });
export const employeeSchema = paymentTotalsSchema.merge(salesTotalsSchema).merge(adjustmentTotalsSchema).extend({ id: z.string(), username: z.string() });
export const employeeReportSchema = z.object({ range: rangeSchema, data: z.array(employeeSchema), pagination: pageSchema });
