import { AuthError } from "../auth/errors";
import { tokenHash } from "../security/tokens";
import { balancesCte, safeMoney, validPayment } from "./sql";
import type { CreatePaymentInput, PaymentQuery, PageQuery } from "./schemas";

export const paymentSelect = `SELECT p.id, p.customer_id, c.name AS customer_name, p.sale_id, p.amount_kurus, p.method,
  p.created_by, u.username AS created_by_username, p.created_at, p.reversal_of_payment_id,
  f.kind AS adjustment_kind, f.id AS adjustment_id,
  CASE WHEN ${validPayment} THEN 1 ELSE 0 END AS is_valid,
  CASE WHEN p.idempotency_key = 'initial:' || s.idempotency_key THEN 1 ELSE 0 END AS is_initial,
  CASE WHEN s.status = 'completed' THEN b.remaining_kurus WHEN s.id IS NOT NULL THEN 0 ELSE NULL END AS sale_remaining_kurus
  FROM payments p JOIN customers c ON c.id = p.customer_id JOIN users u ON u.id = p.created_by
  LEFT JOIN sales s ON s.id = p.sale_id LEFT JOIN balances b ON b.id = s.id
  LEFT JOIN financial_adjustments f ON f.payment_id = coalesce(p.reversal_of_payment_id, p.id)`;
export function presentPayment(row: Record<string, unknown>) {
  safeMoney(row.amount_kurus);
  if (row.sale_remaining_kurus !== null) safeMoney(row.sale_remaining_kurus);
  return { ...row, is_valid: row.is_valid === 1, is_initial: row.is_initial === 1 };
}
export const pageInfo = (query: PageQuery, total: number) => ({ page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) });

export async function createPayment(db: D1Database, actor: string, key: string, input: CreatePaymentInput) {
  const id = crypto.randomUUID();
  const operation = `payment:create:${tokenHash(actor + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([input.customer_id, input.sale_id, input.amount_kurus, input.method]));
  const session = db.withSession("first-primary");
  const now = new Date().toISOString();
  const results = await session.batch([
    // The debt predicate is in the INSERT, inside the same write transaction as the audit.
    // Concurrent writers re-evaluate it after earlier committed payments; never pre-read then write.
    session.prepare(`INSERT INTO payments (id, customer_id, sale_id, amount_kurus, method, created_by, idempotency_key, created_at)
      SELECT ?, s.customer_id, s.id, ?, ?, ?, ?, max(?, s.created_at) FROM sales s
      WHERE s.id = ? AND s.customer_id = ? AND s.status = 'completed'
        AND typeof(s.total_kurus) = 'integer' AND s.total_kurus BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
        AND ? <= s.total_kurus - coalesce((SELECT sum(p.amount_kurus) FROM payments p WHERE p.sale_id = s.id AND ${validPayment}), 0)
        AND NOT EXISTS (SELECT 1 FROM payments WHERE idempotency_key = ?)`)
      .bind(id, input.amount_kurus, input.method, actor, operation, now, input.sale_id, input.customer_id, input.amount_kurus, operation),
    session.prepare(`INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, created_by, 'payment.created', 'payment', id, ?, created_at FROM payments WHERE id = ?`)
      .bind(operation, JSON.stringify({ fields: ["customer_id", "sale_id", "amount_kurus", "method"], request_hash: fingerprint }), id),
    session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ? AND actor_user_id = ?").bind(operation, actor),
    session.prepare(`${balancesCte} ${paymentSelect} WHERE p.idempotency_key = ?`).bind(operation),
  ]);
  const audit = results[2]?.results[0] as { metadata: string } | undefined;
  if (!audit) throw new AuthError(422, "PAYMENT_NOT_ALLOWED", "Tahsilat kaydedilmedi. Satışın müşterisini, durumunu ve güncel kalan borcunu kontrol edin.");
  if (JSON.parse(audit.metadata).request_hash !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "Bu işlem anahtarı farklı tahsilat bilgileriyle kullanılmış. Tahsilat geçmişini kontrol edin.");
  return { payment: presentPayment(results[3]?.results[0] as Record<string, unknown>), created: results[0]?.meta.changes === 1 };
}
export async function listPayments(db: D1Database, query: PaymentQuery) {
  const terms: string[] = [], params: (string | number)[] = [];
  for (const field of ["customer_id", "sale_id", "method"] as const) if (query[field]) { terms.push(`p.${field} = ?`); params.push(query[field]); }
  if (query.status === "valid") terms.push(validPayment);
  if (query.from) { terms.push("p.created_at >= ?"); params.push(new Date(query.from).toISOString()); }
  if (query.to) { terms.push("p.created_at < ?"); params.push(new Date(query.to).toISOString()); }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`SELECT count(*) AS total FROM payments p ${where}`).bind(...params),
    session.prepare(`${balancesCte} ${paymentSelect} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  return { data: (results[1]?.results as Record<string, unknown>[]).map(presentPayment),
    pagination: pageInfo(query, (results[0]?.results[0] as { total: number }).total) };
}
