import { tokenHash } from "../security/tokens";
import { AuthError } from "../auth/errors";
import type { CreateProductInput, PatchProductInput, ProductQuery } from "./schemas";

type Row = { id: string; name: string; current_price_kurus: number; is_active: number; created_at: string; updated_at: string };
const columns = "id, name, current_price_kurus, is_active, created_at, updated_at";
const present = (row: Row) => ({ ...row, is_active: row.is_active === 1 });
const missing = () => new AuthError(404, "PRODUCT_NOT_FOUND", "Ürün bulunamadı.");

export async function getProduct(db: D1Database, id: string) {
  const row = await db.withSession("first-primary").prepare(`SELECT ${columns} FROM products WHERE id = ?`).bind(id).first<Row>();
  if (!row) throw missing();
  return present(row);
}
export async function listProducts(db: D1Database, query: ProductQuery) {
  const terms: string[] = [];
  const params: (string | number)[] = [];
  if (query.status !== "all") { terms.push("is_active = ?"); params.push(query.status === "active" ? 1 : 0); }
  if (query.q) {
    let name = "name";
    for (const [upper, lower] of [["İ", "i"], ["I", "ı"], ["Ğ", "ğ"], ["Ü", "ü"], ["Ş", "ş"], ["Ö", "ö"], ["Ç", "ç"]]) {
      name = `replace(${name}, '${upper}', '${lower}')`;
    }
    terms.push(`instr(lower(${name}), ?) > 0`);
    params.push(query.q.toLocaleLowerCase("tr-TR"));
  }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`SELECT COUNT(*) AS total FROM products ${where}`).bind(...params),
    session.prepare(`SELECT ${columns} FROM products ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  const total = (results[0]?.results[0] as { total: number }).total;
  return { data: (results[1]?.results as Row[]).map(present), pagination: {
    page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize),
  } };
}
export async function createProduct(db: D1Database, actor: string, key: string, input: CreateProductInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const operation = `product:create:${tokenHash(actor + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([input.name, input.current_price_kurus, input.is_active]));
  const metadata = JSON.stringify({ fields: ["name", "current_price_kurus", "is_active"], request_hash: fingerprint });
  const session = db.withSession("first-primary");
  // The existing audit primary key serializes retries. Product + audit commit or roll back together.
  const results = await session.batch([
    session.prepare(`INSERT INTO products (${columns}) SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE id = ?)`)
      .bind(id, input.name, input.current_price_kurus, Number(input.is_active), now, now, operation),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'product.created', 'product', id, ?, ? FROM products WHERE id = ?`)
      .bind(operation, actor, metadata, now, id),
    session.prepare("SELECT metadata FROM audit_logs WHERE id = ? AND actor_user_id = ?").bind(operation, actor),
    session.prepare(`SELECT ${columns.split(", ").map(field => `p.${field}`).join(", ")} FROM products p JOIN audit_logs a ON a.entity_id = p.id WHERE a.id = ?`).bind(operation),
  ]);
  const audit = results[2]?.results[0] as { metadata: string } | undefined;
  if (!audit || JSON.parse(audit.metadata).request_hash !== fingerprint) {
    throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Bu işlem anahtarı farklı bilgilerle kullanılmış. Ürün listesini kontrol edin.");
  }
  return { product: present(results[3]?.results[0] as Row), created: results[0]?.meta.changes === 1 };
}
export async function patchProduct(db: D1Database, actor: string, id: string, input: PatchProductInput) {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  const allowed = new Set(["name", "current_price_kurus", "is_active"]);
  if (!entries.length || entries.some(([field]) => !allowed.has(field))) throw new AuthError(400, "INVALID_PRODUCT_INPUT", "Geçersiz ürün alanı.");
  const now = new Date().toISOString();
  const session = db.withSession("first-primary");
  // Only current catalog values change. Historical sale_items snapshots are never updated here.
  const results = await session.batch([
    session.prepare(`UPDATE products SET ${entries.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ? RETURNING ${columns}`)
      .bind(...entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value), now, id),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'product.updated', 'product', id, ?, ? FROM products WHERE id = ? AND updated_at = ?`)
      .bind(crypto.randomUUID(), actor, JSON.stringify({ fields: entries.map(([field]) => field) }), now, id, now),
  ]);
  const row = results[0]?.results[0] as Row | undefined;
  if (!row) throw missing();
  return present(row);
}
