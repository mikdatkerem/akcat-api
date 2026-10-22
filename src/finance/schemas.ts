import { z } from "zod";
import { money, paymentMethod, saleSummarySchema } from "../sales/schemas";
const optional = <S extends z.ZodType>(schema: S) => z.preprocess(value => value === null || value === "" ? undefined : value, schema.optional());
export const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
export const pageSchema = z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() });
export const createPaymentSchema = z.object({ customer_id: z.uuid(), sale_id: z.uuid(), amount_kurus: money.refine(value => value > 0), method: paymentMethod }).strict();
export const paymentQuery = pagination.extend({ customer_id: optional(z.uuid()), sale_id: optional(z.uuid()), method: optional(paymentMethod),
  from: optional(z.iso.datetime()), to: optional(z.iso.datetime()), status: z.enum(["all", "valid"]).default("all"),
}).refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
export const debtQuery = pagination.extend({ q: z.preprocess(value => value === null ? "" : value, z.string().trim().normalize("NFC").max(100).default("")) });
export const ledgerQuery = pagination.extend({ type: z.enum(["all", "sale", "payment", "reversal", "cancellation"]).default("all"), from: optional(z.iso.datetime()), to: optional(z.iso.datetime()) })
  .refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
export const summarySchema = z.object({ total_debt_kurus: money, open_sales_count: z.number().int().nonnegative(), last_payment_at: z.string().nullable() });
export const customerSchema = z.object({ id: z.uuid(), name: z.string(), phone: z.string().nullable() });
export const paymentSchema = z.object({ id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), sale_id: z.uuid().nullable(),
  amount_kurus: money, method: paymentMethod, created_by: z.uuid(), created_by_username: z.string(), created_at: z.string(),
  is_initial: z.boolean(), is_valid: z.boolean(), reversal_of_payment_id: z.string().nullable(), sale_remaining_kurus: money.nullable() });
export const debtRowSchema = customerSchema.extend(summarySchema.shape);
export const customerDebtSchema = z.object({ customer: customerSchema, summary: summarySchema, data: z.array(saleSummarySchema), pagination: pageSchema });
export const ledgerRowSchema = z.object({ id: z.string(), type: z.enum(["sale", "payment", "reversal", "cancellation"]), sale_id: z.uuid(), amount_kurus: money,
  method: paymentMethod.nullable(), created_at: z.string(), created_by: z.uuid(), created_by_username: z.string(),
  effective: z.boolean(), balance_after_kurus: z.number().int(), sale_balance_after_kurus: z.number().int() });
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type PaymentQuery = z.infer<typeof paymentQuery>;
export type DebtQuery = z.infer<typeof debtQuery>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
export type PageQuery = z.infer<typeof pagination>;
