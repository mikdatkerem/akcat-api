import { z } from "zod";
import { pagination } from "../finance/schemas";
import { money } from "../sales/schemas";

export const reasonSchema = z.string().trim().normalize("NFC").min(1).max(1000);
export const reasonBody = z.object({ reason: reasonSchema }).strict();
export const correctionType = z.enum(["sale_cancel", "sale_customer", "sale_items", "sale_error", "payment_amount", "payment_method", "payment_reversal", "payment_refund"]);
export const approvalBody = reasonBody.extend({ expected_amount_kurus: money.optional(), expected_sale_remaining_kurus: money.optional(),
  expected_customer_debt_kurus: money.optional(), refund_confirmation: z.object({ confirmed: z.literal(true), reference: z.string().trim().normalize("NFC").min(1).max(200) }).strict().optional() }).strict();
export const financialPreviewSchema = z.object({ payment_id: z.string(), sale_id: z.string(), customer_id: z.string(), customer_name: z.string(),
  amount_kurus: money, method: z.enum(["cash", "card", "bank"]), original_created_at: z.string(), original_created_by_username: z.string(),
  before_sale_remaining_kurus: money, after_sale_remaining_kurus: money, before_customer_debt_kurus: money, after_customer_debt_kurus: money,
  requires_external_confirmation: z.boolean() });
export const createCorrectionSchema = z.object({ target_type: z.enum(["sale", "payment"]), target_id: z.uuid(),
  correction_type: correctionType, reason: reasonSchema, requested_change: reasonSchema,
}).strict().refine(value => value.target_type === "payment" ? value.correction_type.startsWith("payment_") : value.correction_type.startsWith("sale_"));
export const correctionQuery = pagination.extend({ status: z.enum(["all", "pending", "approved", "rejected"]).default("pending") });
export const correctionSchema = z.object({ id: z.uuid(), target_type: z.enum(["sale", "payment"]), target_id: z.string(),
  requested_by: z.string(), requested_by_username: z.string(), reason: z.string(), correction_type: z.string(), requested_change: z.string(),
  status: z.enum(["pending", "approved", "rejected"]), reviewed_by: z.string().nullable(), reviewed_by_username: z.string().nullable(),
  reviewed_at: z.string().nullable(), created_at: z.string(), can_approve: z.boolean(), approval_explanation: z.string(),
  financial_preview: financialPreviewSchema.nullable(), adjustment: z.record(z.string(), z.unknown()).nullable(),
  cancellation_preview: z.object({ sale_id: z.string(), amount_kurus: money, before_sale_remaining_kurus: money,
    after_sale_remaining_kurus: money, before_customer_debt_kurus: money, after_customer_debt_kurus: money }).nullable(),
  history: z.array(z.object({ action: z.string(), actor_user_id: z.string(), username: z.string(), created_at: z.string(), metadata: z.unknown() })),
});
export type CreateCorrection = z.infer<typeof createCorrectionSchema>;
export type CorrectionQuery = z.infer<typeof correctionQuery>;
export type ApprovalBody = z.infer<typeof approvalBody>;
