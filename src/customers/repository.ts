import { tokenHash } from "../security/tokens";
import { AuthError } from "../auth/errors";
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
  return { customer: present(results[3]?.results[0] as Row), created: results[0]?.meta.changes === 1 };
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
