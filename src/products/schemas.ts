import { z } from "zod";

const name = z.string().trim().normalize("NFC").min(1).max(160).refine(value =>
  Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
// JSON numbers must remain exact throughout Workers, SQLite and the React client.
const price = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const createProductSchema = z.object({
  name, current_price_kurus: price, is_active: z.boolean().default(true),
}).strict();
export const patchProductSchema = z.object({
  expected_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  name: name.optional(), current_price_kurus: price.optional(), is_active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).some(field => field !== "expected_version"));
export const productParams = z.object({ id: z.uuid() });
export const productQuery = z.object({
  q: z.preprocess(value => value === null ? "" : value, z.string().trim().normalize("NFC").max(100).default("")),
  status: z.enum(["all", "active", "inactive"]).default("all"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const productSchema = z.object({
  version: z.number().int().positive(),
  id: z.uuid(), name: z.string(), current_price_kurus: price, is_active: z.boolean(),
  created_at: z.string(), updated_at: z.string(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type PatchProductInput = z.infer<typeof patchProductSchema>;
export type ProductQuery = z.infer<typeof productQuery>;
