import { AuthError } from "../auth/errors";
import { tokenHash } from "../security/tokens";
import { authorizedBatch } from "../security/authorizedBatch";
import type { AuthSession } from "../types";

// Table/column configuration is internal, never taken from a request.
export async function patchRecord<T>(db: D1Database, auth: AuthSession, table: "products" | "customers", columns: string,
  id: string, key: string, expected: number, entries: [string, string | number | boolean | null][]) {
  const entity = table === "products" ? "product" : "customer", now = new Date().toISOString(), attempt = crypto.randomUUID();
  const allowed = table === "products" ? ["name", "current_price_kurus", "is_active"] : ["name", "phone", "address", "delivery_notes", "is_active"];
  if (!entries.length || entries.some(([field]) => !allowed.includes(field))) throw new AuthError(400, "INVALID_INPUT", "Geçersiz güncelleme alanı.");
  entries.sort(([a], [b]) => a.localeCompare(b));
  const operation = `${entity}:update:${tokenHash(auth.user.id + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([id, expected, entries]));
  const newPrice = table === "products" ? entries.find(([field]) => field === "current_price_kurus")?.[1] : undefined;
  const priceMetadata = newPrice === undefined ? "" : ",'old_price_kurus',current_price_kurus,'new_price_kurus',CAST(? AS INTEGER)";
  const session = db.withSession("first-primary");
  const results = await authorizedBatch(session, auth, [
    session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      SELECT ?,?,?,?,?,json_object('fields',json(?),'request_hash',?,'attempt',?,'before_version',version,'after_version',version+1${priceMetadata}),?
      FROM ${table} WHERE id=? AND version=? AND version<${Number.MAX_SAFE_INTEGER}
        AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
      .bind(operation, auth.user.id, `${entity}.updated`, entity, id, JSON.stringify(entries.map(([field]) => field)), fingerprint, attempt,
        ...(newPrice === undefined ? [] : [newPrice]), now, id, expected, operation),
    session.prepare(`UPDATE ${table} SET ${entries.map(([field]) => `${field}=?`).join(",")},updated_at=?,version=version+1
      WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND json_extract(metadata,'$.attempt')=?)`)
      .bind(...entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value), now, id, expected, operation, attempt),
    session.prepare("SELECT metadata FROM audit_logs WHERE id=? AND actor_user_id=?").bind(operation, auth.user.id),
    session.prepare(`SELECT ${columns} FROM ${table} WHERE id=?`).bind(id),
  ]);
  const audit = results[2]?.results[0], row = results[3]?.results[0] as T | undefined;
  if (audit) {
    if (JSON.parse(String(audit.metadata)).request_hash !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "İşlem anahtarı farklı güncelleme için kullanılmış.");
    if (!row) throw new AuthError(409, `${entity.toUpperCase()}_DELETED`, "Kayıt daha sonra silinmiş.");
    return row; // Replay reads the current record; it never reapplies an old change.
  }
  if (!row) throw new AuthError(404, `${entity.toUpperCase()}_NOT_FOUND`, "Kayıt bulunamadı.");
  throw new AuthError(409, "RECORD_VERSION_CONFLICT", "Bu kayıt siz düzenlerken değiştirildi. Güncel bilgileri yükleyip tekrar inceleyin.");
}
