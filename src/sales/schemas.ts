import { z } from "zod";

export const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const paymentMethod = z.enum(["cash", "card", "bank"]);
export const createSaleSchema = z.object({
  customer_id: z.uuid(),
  // Only the optional unit price is writable; line/sale totals and list snapshots remain server-owned.
  items: z.array(z.object({ product_id: z.uuid(), quantity: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    unit_price_kurus: money.min(1).optional() }))
    .min(1).max(50).refine(items => new Set(items.map(item => item.product_id)).size === items.length),
  payment: z.object({ amount_kurus: money, method: paymentMethod.nullable().optional() })
    .refine(value => value.amount_kurus === 0 || !!value.method)
    .transform(value => ({ amount_kurus: value.amount_kurus, method: value.amount_kurus === 0 ? null : value.method! })),
});
const optional = <S extends z.ZodType>(schema: S) => z.preprocess(value => value === null || value === "" ? undefined : value, schema.optional());
export const saleQuery = z.object({
  customer_id: optional(z.uuid()), from: optional(z.iso.datetime()), to: optional(z.iso.datetime()),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
export const saleParams = z.object({ id: z.uuid() });
export const saleSummarySchema = z.object({
  id: z.uuid(), customer_id: z.uuid(), customer_name: z.string(), created_by: z.uuid(), created_by_username: z.string(),
  status: z.enum(["completed", "cancelled"]), total_kurus: money, paid_kurus: money, remaining_kurus: money,
  payment_status: z.enum(["paid", "partial", "credit"]), created_at: z.string(), updated_at: z.string(),
});
export const saleDetailSchema = saleSummarySchema.extend({
  cancellation_history: z.array(z.object({ actor_user_id: z.string(), username: z.string(), created_at: z.string(), reason: z.string(),
    correction_id: z.string().nullable(), approved_by: z.string().nullable() }).passthrough()),
  cancellation_eligibility: z.object({ allowed: z.boolean(), expires_at: z.string().nullable(), explanation: z.string() }),
  customer: z.object({ id: z.uuid(), name: z.string(), phone: z.string().nullable(), address: z.string() }),
  items: z.array(z.object({ id: z.uuid(), product_id: z.uuid(), product_name_snapshot: z.string(), list_unit_price_kurus: money.nullable(), unit_price_kurus: money,
    quantity: z.number().int().positive(), line_total_kurus: money })),
  payments: z.array(z.object({ id: z.uuid(), amount_kurus: money, method: paymentMethod, created_at: z.string(),
    created_by: z.uuid(), created_by_username: z.string(), is_initial: z.boolean() })),
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type SaleQuery = z.infer<typeof saleQuery>;
