import { z } from "zod";
import { usernameSchema, strongPassword } from "../auth/schemas";
import { pagination, pageSchema } from "../finance/schemas";

export const userParams = z.object({ id: z.uuid() });
export const mutationHeaders = z.object({ "idempotency-key": z.uuid() });
export const userSchema = z.object({ id: z.uuid(), username: z.string(), role: z.enum(["admin", "employee"]), is_active: z.boolean(), created_at: z.string(), updated_at: z.string() });
export const userPageSchema = z.object({ data: z.array(userSchema), pagination: pageSchema });
export const createUserSchema = z.object({ username: usernameSchema, password: strongPassword, role: z.enum(["admin", "employee"]).default("employee") }).strict();
export const patchUserSchema = z.object({ username: usernameSchema.optional(), role: z.enum(["admin", "employee"]).optional(), is_active: z.boolean().optional() }).strict()
  .refine(value => Object.values(value).some(field => field !== undefined));
export const resetPasswordSchema = z.object({ password: strongPassword }).strict();
export const userQuery = pagination.extend({ q: z.preprocess(value => value === null ? "" : value, z.string().trim().max(100).default("")),
  status: z.enum(["all", "active", "inactive"]).default("all") });
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type PatchUserInput = z.infer<typeof patchUserSchema>;
export type UserQuery = z.infer<typeof userQuery>;
