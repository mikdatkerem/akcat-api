import { z } from "zod";

const safeText = (value: string) => Array.from(value).every(character => {
  const code = character.charCodeAt(0);
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
});
const text = (limit: number) => z.string().trim().normalize("NFC").min(1).max(limit).refine(safeText);
const optionalText = (limit: number) => z.string().trim().max(limit).nullable().optional()
  .transform(value => value || null);
export const phoneSchema = optionalText(64)
  .transform(value => value?.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-") || null).refine(value => {
  if (!value) return true;
  if (!/^\+?[\d () .-]+(?:\s*(?:x|ext\.?|dahili)\s*\d{1,6})?$/i.test(value)) return false;
  const main = value.split(/x|ext\.?|dahili/i)[0] ?? "";
  const length = main.replace(/\D/g, "").replace(/^00/, "").length;
  return length >= 7 && length <= 15;
}, "Geçerli bir telefon numarası girin (7–15 rakam; varsa dahili ayrı).");
const notes = optionalText(2000).refine(value => !value || safeText(value));
export const createCustomerSchema = z.object({
  name: text(160), phone: phoneSchema, address: text(1000), delivery_notes: notes,
}).strict();
// Do not use .partial() on transformed optional fields: omitted fields must stay omitted.
export const patchCustomerSchema = z.object({
  name: text(160).optional(), phone: phoneSchema.optional(), address: text(1000).optional(),
  delivery_notes: notes.optional(), is_active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);
export const customerParams = z.object({ id: z.uuid() });
export const customerQuery = z.object({
  q: z.preprocess(value => value === null ? "" : value, z.string().trim().normalize("NFC").max(100).default("")),
  status: z.enum(["all", "active", "inactive"]).default("all"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const customerSchema = z.object({
  id: z.uuid(), name: z.string(), phone: z.string().nullable(), address: z.string(),
  delivery_notes: z.string().nullable(), is_active: z.boolean(), created_at: z.string(), updated_at: z.string(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type PatchCustomerInput = z.infer<typeof patchCustomerSchema>;
export type CustomerQuery = z.infer<typeof customerQuery>;
