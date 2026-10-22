import { z } from "zod";
import { pagination } from "../finance/schemas";

export const reasonSchema = z.string().trim().normalize("NFC").min(1).max(1000);
export const reasonBody = z.object({ reason: reasonSchema }).strict();
export const correctionType = z.enum(["sale_cancel", "sale_customer", "sale_items", "sale_error", "payment_amount", "payment_method"]);
export const createCorrectionSchema = z.object({ target_type: z.enum(["sale", "payment"]), target_id: z.uuid(),
  correction_type: correctionType, reason: reasonSchema, requested_change: reasonSchema,
}).strict().refine(value => value.target_type === "payment" ? value.correction_type.startsWith("payment_") : value.correction_type.startsWith("sale_"));
export const correctionQuery = pagination.extend({ status: z.enum(["all", "pending", "approved", "rejected"]).default("pending") });
export const correctionSchema = z.object({ id: z.uuid(), target_type: z.enum(["sale", "payment"]), target_id: z.string(),
  requested_by: z.string(), requested_by_username: z.string(), reason: z.string(), correction_type: z.string(), requested_change: z.string(),
  status: z.enum(["pending", "approved", "rejected"]), reviewed_by: z.string().nullable(), reviewed_by_username: z.string().nullable(),
  reviewed_at: z.string().nullable(), created_at: z.string(), can_approve: z.boolean(), approval_explanation: z.string(),
  history: z.array(z.object({ action: z.string(), actor_user_id: z.string(), username: z.string(), created_at: z.string(), metadata: z.unknown() })),
});
export type CreateCorrection = z.infer<typeof createCorrectionSchema>;
export type CorrectionQuery = z.infer<typeof correctionQuery>;
