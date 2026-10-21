import { z } from "zod";

export const usernameSchema = z.string().max(128)
  .transform((value) => value.normalize("NFKC").trim().toLocaleLowerCase("tr-TR"))
  .pipe(z.string().min(3).max(64).regex(/^[\p{L}\p{N}._-]+$/u));
export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
}).strict();
export const bootstrapSchema = loginSchema.extend({ password: z.string().min(15).max(128) });
export const publicUserSchema = z.object({
  id: z.string(), username: z.string(), role: z.enum(["admin", "employee"]),
});
export const sessionResponseSchema = z.object({
  user: publicUserSchema, expiresAt: z.string(), csrfToken: z.string().optional(),
});
