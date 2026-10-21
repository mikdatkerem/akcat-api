import { randomUUID } from "node:crypto";
import { hashPassword } from "../security/password.ts";
import { bootstrapSchema } from "./schemas.ts";

export const BOOTSTRAP_MARKER = "system:first-admin-bootstrap";
export type Statement = { sql: string; params: string[] };
export type ExecuteBatch = (statements: Statement[]) => Promise<{ meta: { changes?: number } }[]>;

export class BootstrapUnavailable extends Error {
  constructor() { super("İlk admin kurulumu kullanılamıyor; mevcut admin veya tamamlanmış kurulum var."); }
}

// Called only by an explicitly authorized operator CLI, never mounted as an API route.
export async function bootstrapAdmin(execute: ExecuteBatch, input: unknown): Promise<void> {
  const validated = bootstrapSchema.safeParse(input);
  if (!validated.success) throw new Error("Kullanıcı adı geçersiz veya parola 15–128 karakter aralığında değil.");
  const { username, password } = validated.data;
  const hash = await hashPassword(password);
  const id = randomUUID();
  const now = new Date().toISOString();
  // A single atomic batch and audit PK prevent concurrent or subsequent bootstraps.
  const result = await execute([
    {
      sql: `INSERT INTO users (id, username, password_hash, role, is_active, created_at, updated_at)
        SELECT ?, ?, ?, 'admin', 1, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`,
      params: [id, username, hash, now, now, BOOTSTRAP_MARKER],
    },
    {
      sql: `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, created_at)
        SELECT ?, id, 'auth.bootstrap_admin', 'user', id, ? FROM users WHERE id = ?`,
      params: [BOOTSTRAP_MARKER, now, id],
    },
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw new BootstrapUnavailable();
}
