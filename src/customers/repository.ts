import { tokenHash } from "../security/tokens";
import { AuthError, forbidden } from "../auth/errors";
import type { AuthSession } from "../types";
import type { CreateCustomerInput, PatchCustomerInput, CustomerQuery } from "./schemas";

type Row = { id: string; name: string; phone: string | null; address: string; delivery_notes: string | null;
  is_active: number; created_at: string; updated_at: string };
const columns = "id, name, phone, address, delivery_notes, is_active, created_at, updated_at";
const present = (row: Row) => ({ ...row, is_active: row.is_active === 1 });
export const missingCustomer = () => new AuthError(404, "CUSTOMER_NOT_FOUND", "Müşteri bulunamadı.");

export async function getCustomer(db: D1Database, id: string) {
  const row = await db.withSession("first-primary").prepare(`SELECT ${columns} FROM customers WHERE id = ?`).bind(id).first<Row>();
  if (!row) throw missingCustomer();
  return present(row);
}

export async function listCustomers(db: D1Database, query: CustomerQuery) {
  const terms: string[] = [];
  const params: (string | number)[] = [];
  if (query.status !== "all") { terms.push("is_active = ?"); params.push(query.status === "active" ? 1 : 0); }
  if (query.q) {
    let name = "name";
    for (const [upper, lower] of [["İ", "i"], ["I", "ı"], ["Ğ", "ğ"], ["Ü", "ü"], ["Ş", "ş"], ["Ö", "ö"], ["Ç", "ç"]]) {
      name = `replace(${name}, '${upper}', '${lower}')`;
    }
    let phone = "coalesce(phone, '')";
    for (const separator of [" ", "+", "-", "(", ")", "."]) phone = `replace(${phone}, '${separator}', '')`;
    const phoneQuery = query.q.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-");
    const digits = /^[+\d () .-]+$/.test(phoneQuery) ? phoneQuery.replace(/\D/g, "") : "";
    terms.push(`(instr(lower(${name}), ?) > 0 OR (? <> '' AND instr(${phone}, ?) > 0))`);
    params.push(query.q.toLocaleLowerCase("tr-TR"), digits, digits);
  }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`SELECT COUNT(*) AS total FROM customers ${where}`).bind(...params),
    session.prepare(`SELECT ${columns} FROM customers ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  const total = (results[0]?.results[0] as { total: number }).total;
  return { data: (results[1]?.results as Row[]).map(present), pagination: {
    page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize),
  } };
}

export async function createCustomer(db: D1Database, actor: string, key: string, input: CreateCustomerInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const operation = `customer:create:${tokenHash(actor + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([input.name, input.phone, input.address, input.delivery_notes]));
  // Audit metadata keeps field names and an idempotency digest, never contact/address/note values.
  const metadata = JSON.stringify({ fields: ["name", "phone", "address", "delivery_notes"], request_hash: fingerprint });
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`INSERT INTO customers (${columns}) SELECT ?, ?, ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`)
      .bind(id, input.name, input.phone, input.address, input.delivery_notes, now, now, operation),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'customer.created', 'customer', id, ?, ? FROM customers WHERE id = ?`)
      .bind(operation, actor, metadata, now, id),
    session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ? AND actor_user_id = ?").bind(operation, actor),
    session.prepare(`SELECT ${columns.split(", ").map(field => `c.${field}`).join(", ")} FROM customers c JOIN audit_logs a ON a.entity_id = c.id WHERE a.id = ?`).bind(operation),
  ]);
  const audit = results[2]?.results[0] as { metadata: string } | undefined;
  if (!audit || JSON.parse(audit.metadata).request_hash !== fingerprint) {
    throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Bu işlem anahtarı farklı bilgilerle kullanılmış. Müşteri listesini kontrol edin.");
  }
  const customer = results[3]?.results[0] as Row | undefined;
  if (!customer) throw new AuthError(409, "CUSTOMER_DELETED", "Bu işlemle oluşturulan müşteri daha sonra silinmiş. Müşteri listesini yenileyin.");
  return { customer: present(customer), created: results[0]?.meta.changes === 1 };
}

export async function patchCustomer(db: D1Database, actor: string, id: string, input: PatchCustomerInput) {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  const allowed = new Set(["name", "phone", "address", "delivery_notes", "is_active"]);
  if (entries.some(([field]) => !allowed.has(field))) throw new AuthError(400, "INVALID_INPUT", "Geçersiz müşteri alanı.");
  const now = new Date().toISOString();
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`UPDATE customers SET ${entries.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ? RETURNING ${columns}`)
      .bind(...entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value), now, id),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'customer.updated', 'customer', id, ?, ? FROM customers WHERE id = ? AND updated_at = ?`)
      .bind(crypto.randomUUID(), actor, JSON.stringify({ fields: entries.map(([field]) => field) }), now, id, now),
  ]);
  const row = results[0]?.results[0] as Row | undefined;
  if (!row) throw missingCustomer();
  return present(row);
}

// Debt/ledger are derived from sales/payments; corrections retain those same targets.
// Only the technical creation audit is exempt. Updates and every other customer audit block deletion.
const customerHistory = `EXISTS(SELECT 1 FROM sales WHERE customer_id=c.id)
  OR EXISTS(SELECT 1 FROM payments WHERE customer_id=c.id)
  OR EXISTS(SELECT 1 FROM financial_adjustments WHERE customer_id=c.id)
  OR EXISTS(SELECT 1 FROM audit_logs WHERE entity_type='customer' AND entity_id=c.id AND action<>'customer.created')`;
const deleteActorGate = `EXISTS(SELECT 1 FROM users actor JOIN sessions ses ON ses.user_id=actor.id
  WHERE actor.id=? AND actor.role='admin' AND actor.is_active=1 AND ses.id=? AND ses.revoked_at IS NULL AND ses.expires_at>?)`;
const customerInUse = () => new AuthError(409, "CUSTOMER_IN_USE", "Bu müşterinin geçmiş işlem kayıtları bulunduğu için kalıcı olarak silinemez. Müşteriyi pasife alabilirsiniz.");

export async function deleteCustomer(db: D1Database, auth: AuthSession, id: string, key: string) {
  const operation = `customer:delete:${tokenHash(auth.user.id + ":" + key)}`;
  const attempt = crypto.randomUUID(), now = new Date().toISOString(), session = db.withSession("first-primary");
  let rows: D1Result<Record<string, unknown>>[];
  try {
    rows = await session.batch([
      session.prepare(`SELECT ${deleteActorGate} AS allowed`).bind(auth.user.id, auth.id, now),
      // Keep existing audits; do not copy names, addresses, phones or notes into deletion metadata.
      session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
        SELECT ?,?,'customer.deleted','customer',c.id,json_object('attempt',?),? FROM customers c
        WHERE c.id=? AND NOT (${customerHistory}) AND ${deleteActorGate}
          AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
        .bind(operation, auth.user.id, attempt, now, id, auth.user.id, auth.id, now, operation),
      session.prepare(`DELETE FROM customers WHERE id=?
        AND EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND json_extract(metadata,'$.attempt')=?)`).bind(id, operation, attempt),
      session.prepare("SELECT entity_id FROM audit_logs WHERE id=? AND actor_user_id=?").bind(operation, auth.user.id),
      session.prepare(`SELECT c.id,(${customerHistory}) AS history FROM customers c WHERE c.id=?`).bind(id),
    ]);
  } catch (cause) {
    let error: unknown = cause;
    for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
      if (/FOREIGN KEY constraint failed/i.test(error.message)) throw customerInUse();
    }
    throw cause;
  }
  if (rows[0]?.results[0]?.allowed !== 1) throw forbidden();
  const audit = rows[3]?.results[0], customer = rows[4]?.results[0];
  if (audit) {
    if (audit.entity_id !== id) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Bu işlem anahtarı başka bir müşteri için kullanılmış.");
    return { success: true as const, id };
  }
  if (!customer) throw missingCustomer();
  if (customer.history === 1) throw customerInUse();
  throw new AuthError(409, "CUSTOMER_DELETE_CONFLICT", "Müşteri silinemedi. Listeyi yenileyip tekrar deneyin.");
}
