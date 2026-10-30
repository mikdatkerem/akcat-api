import type { AuthSession } from "../types";
import { authorizedBatch } from "../security/authorizedBatch";
import { AuthError } from "../auth/errors";
import { tokenHash } from "../security/tokens";
import type { CreateSaleInput, SaleQuery } from "./schemas";
import { validPayment } from "../finance/sql";
import type { PublicUser } from "../types";

const MAX = Number.MAX_SAFE_INTEGER;
export const summarySelect = `SELECT s.id, s.sale_type, s.walk_in_customer_name, s.customer_id, coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri') AS customer_name, s.created_by, u.username AS created_by_username,
  s.status, s.total_kurus, s.created_at, s.updated_at,
  coalesce((SELECT sum(p.amount_kurus) FROM payments p WHERE p.sale_id = s.id AND ${validPayment}), 0) AS paid_kurus
  FROM sales s LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.created_by`;
export type SummaryRow = { id: string; sale_type: "normal" | "walk_in"; walk_in_customer_name: string | null; customer_id: string | null; customer_name: string; created_by: string; created_by_username: string;
  status: "completed" | "cancelled"; total_kurus: number; paid_kurus: number; created_at: string; updated_at: string };
export function presentSale(row: SummaryRow) {
  if (![row.total_kurus, row.paid_kurus].every(value => Number.isSafeInteger(value) && value >= 0) || row.paid_kurus > row.total_kurus) {
    throw new Error("Invalid stored sale amounts");
  }
  if (row.sale_type === "walk_in" && row.status === "completed" && row.paid_kurus !== row.total_kurus) throw new Error("Incomplete walk-in payment");
  return { ...row, remaining_kurus: row.status === "cancelled" ? 0 : row.total_kurus - row.paid_kurus,
    payment_status: row.paid_kurus === row.total_kurus ? "paid" as const : row.paid_kurus > 0 ? "partial" as const : "credit" as const };
}
export async function getSale(db: D1Database, id: string, actor?: PublicUser) {
  const session = db.withSession("first-primary");
  const params = [id];
  const results = await session.batch<Record<string, unknown>>([
    session.prepare(`${summarySelect} WHERE s.id = ?`).bind(...params),
    session.prepare(`SELECT c.id, c.name, c.phone, c.address FROM customers c JOIN sales s ON s.customer_id = c.id WHERE s.id = ?`).bind(...params),
    session.prepare(`SELECT i.id, i.product_id, i.product_name_snapshot, i.list_unit_price_kurus, i.unit_price_kurus, i.quantity, i.line_total_kurus
      FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.id = ? ORDER BY i.id`).bind(...params),
    session.prepare(`SELECT p.id, p.amount_kurus, p.method, p.created_at, p.created_by, u.username AS created_by_username,
      CASE WHEN p.idempotency_key = 'initial:' || s.idempotency_key THEN 1 ELSE 0 END AS is_initial
      FROM payments p JOIN sales s ON s.id = p.sale_id JOIN users u ON u.id = p.created_by
      WHERE s.id = ? AND ${validPayment} ORDER BY p.created_at, p.id`).bind(...params),
    session.prepare(`SELECT a.actor_user_id, u.username, a.created_at, a.metadata FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
      WHERE a.entity_type = 'sale' AND a.entity_id = ? AND a.action = 'sale.cancelled' ORDER BY a.created_at, a.id`).bind(id),
    session.prepare("SELECT count(*) AS total FROM payments WHERE sale_id = ?").bind(id),
  ]);
  const row = results[0]?.results[0] as SummaryRow | undefined;
  if (!row) throw new AuthError(404, "SALE_NOT_FOUND", "Satış bulunamadı.");
  const hasPayments = Number(results[5]?.results[0]?.total) > 0;
  const elapsed = Date.now() - Date.parse(row.created_at);
  const allowed = !!actor && row.status === "completed" && !hasPayments
    && (actor.role === "admin" || (actor.id === row.created_by && elapsed >= 0 && elapsed <= 300000));
  return { ...presentSale(row), customer: results[1]?.results[0] ?? null, items: results[2]?.results,
    cancellation_history: results[4]?.results.map(log => {
      const metadata = JSON.parse(String(log.metadata));
      return { actor_user_id: log.actor_user_id, username: log.username, created_at: log.created_at,
        reason: metadata.reason, before: metadata.before, after: metadata.after, correction_id: metadata.correction_id, approved_by: metadata.approved_by };
    }),
    cancellation_eligibility: { allowed, expires_at: actor?.role === "employee" ? new Date(Date.parse(row.created_at) + 300000).toISOString() : null,
      explanation: row.status === "cancelled" ? "Satış zaten iptal edildi." : hasPayments ? "Ödeme geçmişi bulunan satış doğrudan iptal edilemez; finansal düzeltme talebi oluşturun."
        : allowed ? "Gerekçe ile iptal edilebilir. Asıl kayıt korunur ve güncel borcu kapatılır." : "Çalışan yalnızca kendi ödemesiz satışını ilk beş dakika içinde iptal edebilir; düzeltme talebi oluşturabilirsiniz." },
    payments: (results[3]?.results as Record<string, unknown>[]).map(payment => ({ ...payment, is_initial: payment.is_initial === 1 })) };
}
export async function listSales(db: D1Database, query: SaleQuery) {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (query.customer_id) { conditions.push("s.customer_id = ?"); params.push(query.customer_id); }
  if (query.from) { conditions.push("s.created_at >= ?"); params.push(new Date(query.from).toISOString()); }
  if (query.to) { conditions.push("s.created_at < ?"); params.push(new Date(query.to).toISOString()); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`SELECT count(*) AS total FROM sales s ${where}`).bind(...params),
    session.prepare(`${summarySelect} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  const total = (results[0]?.results[0] as { total: number }).total;
  return { data: (results[1]?.results as SummaryRow[]).map(presentSale), pagination: {
    page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize),
  } };
}

export async function createSale(db: D1Database, auth: AuthSession, key: string, input: CreateSaleInput) {
  const actor = auth.user.id;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const operation = `sale:create:${tokenHash(actor + ":" + key)}`;
  const items = [...input.items].sort((a, b) => a.product_id.localeCompare(b.product_id));
  const fingerprint = tokenHash(JSON.stringify(input.sale_type === "normal" ? [input.customer_id, items, input.payment] : [null, items, input.payment, "walk_in", input.walk_in_customer_name]));
  const requested = JSON.stringify(items.map(item => ({ ...item, id: crypto.randomUUID() })));
  const session = db.withSession("first-primary");
  // Pricing, active checks and every write execute inside ONE SQLite transaction. No pre-read price window.
  // Each line is bounded BEFORE multiplication; 50 safe lines sum below SQLite's signed 64-bit maximum.
  const results = await authorizedBatch(session, auth, [
    session.prepare(`WITH requested AS (
      SELECT json_extract(value, '$.product_id') AS product_id, json_extract(value, '$.quantity') AS quantity,
        json_extract(value, '$.unit_price_kurus') AS unit_price_kurus, json_extract(value, '$.expected_list_price_kurus') AS expected_price FROM json_each(?)
    ), priced AS (
      SELECT CASE WHEN p.is_active = 1 AND typeof(p.current_price_kurus) = 'integer' AND p.current_price_kurus >= 0
        AND p.current_price_kurus <= ${MAX}
        AND (r.unit_price_kurus IS NOT NULL OR p.current_price_kurus = r.expected_price)
        AND typeof(coalesce(r.unit_price_kurus, p.current_price_kurus)) = 'integer'
        AND coalesce(r.unit_price_kurus, p.current_price_kurus) > 0
        AND coalesce(r.unit_price_kurus, p.current_price_kurus) <= ${MAX} / r.quantity
        THEN coalesce(r.unit_price_kurus, p.current_price_kurus) * r.quantity ELSE NULL END AS line_total
      FROM requested r LEFT JOIN products p ON p.id = r.product_id
    ) INSERT INTO sales (id, customer_id, created_by, status, total_kurus, idempotency_key, created_at, updated_at, sale_type, walk_in_customer_name)
    SELECT ?, ?, ?, 'completed', sum(line_total), ?, ?, ?, ?, ? FROM priced
    HAVING count(line_total) = ? AND sum(line_total) <= ${MAX} AND ? <= sum(line_total)
      AND ((?='normal' AND EXISTS (SELECT 1 FROM customers WHERE id = ? AND is_active = 1))
        OR (?='walk_in' AND ?=sum(line_total) AND sum(line_total)>0))
      AND NOT EXISTS (SELECT 1 FROM sales WHERE idempotency_key = ?)`)
      .bind(requested, id, input.customer_id, actor, operation, now, now, input.sale_type, input.walk_in_customer_name, items.length, input.payment.amount_kurus, input.sale_type, input.customer_id, input.sale_type, input.payment.amount_kurus, operation),
    session.prepare(`INSERT INTO sale_items (id, sale_id, product_id, product_name_snapshot, list_unit_price_kurus, unit_price_kurus, quantity, line_total_kurus)
      SELECT json_extract(j.value, '$.id'), s.id, p.id, p.name, p.current_price_kurus,
        coalesce(json_extract(j.value, '$.unit_price_kurus'), p.current_price_kurus),
        json_extract(j.value, '$.quantity'),
        coalesce(json_extract(j.value, '$.unit_price_kurus'), p.current_price_kurus) * json_extract(j.value, '$.quantity')
      FROM sales s JOIN json_each(?) j JOIN products p ON p.id = json_extract(j.value, '$.product_id') WHERE s.id = ?`)
      .bind(requested, id),
    session.prepare(`INSERT INTO payments (id, customer_id, sale_id, amount_kurus, method, created_by, idempotency_key, created_at)
      SELECT ?, customer_id, id, ?, ?, created_by, 'initial:' || idempotency_key, ? FROM sales WHERE id = ? AND ? > 0`)
      .bind(crypto.randomUUID(), input.payment.amount_kurus, input.payment.method, now, id, input.payment.amount_kurus),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, created_by, 'sale.created', 'sale', id, ?, ? FROM sales WHERE id = ?`)
      .bind(operation, JSON.stringify({ fields: input.sale_type === "walk_in" ? ["sale_type", "walk_in_customer_name", "items", "payment"] : ["customer_id", "items", "payment"], request_hash: fingerprint }), now, id),
    session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ? AND actor_user_id = ?").bind(operation, actor),
    session.prepare(`SELECT p.id AS product_id, p.name, json_extract(j.value, '$.expected_list_price_kurus') AS expected_list_price_kurus, p.current_price_kurus
      FROM json_each(?) j JOIN products p ON p.id=json_extract(j.value, '$.product_id')
      WHERE p.is_active=1 AND json_extract(j.value, '$.unit_price_kurus') IS NULL
        AND p.current_price_kurus <> json_extract(j.value, '$.expected_list_price_kurus')`).bind(requested),
  ]);
  const audit = results[4]?.results[0] as { entity_id: string; metadata: string } | undefined;
  if (!audit && items.some(item => item.unit_price_kurus === undefined && item.expected_list_price_kurus === undefined)) throw new AuthError(428, "PRICE_CONFIRMATION_REQUIRED", "Liste fiyatlarını yenileyip satışı tekrar onaylayın.");
  if (!audit && results[5]!.results.length) throw new AuthError(409, "PRICE_CHANGED", "Ürün fiyatı değişti. Yeni tutarı kontrol edip tekrar onaylayın.", { products: results[5]!.results });
  if (!audit) throw new AuthError(422, "SALE_NOT_ALLOWED", "Satış kaydedilemedi. Müşteriyi, aktif ürünleri, güncel fiyatları ve ödeme tutarını kontrol edin.");
  if (JSON.parse(audit.metadata).request_hash !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Bu işlem anahtarı farklı satış bilgileriyle kullanılmış. Satış geçmişini kontrol edin.");
  return { sale: await getSale(db, audit.entity_id), created: results[0]?.meta.changes === 1 };
}
