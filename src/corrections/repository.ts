import type { AuthSession } from "../types";
import { authorizedBatch } from "../security/authorizedBatch";
import { AuthError, forbidden } from "../auth/errors";
import { tokenHash } from "../security/tokens";
import type { PublicUser } from "../types";
import { pageInfo } from "../finance/payments";
import type { ApprovalBody, CorrectionQuery, CreateCorrection } from "./schemas";

import { adjustablePayment, adjustmentSelect, approveFinancial, cancellableSale, presentPreview, previewSelect } from "./financial";
import { balancesCte, safeMoney } from "../finance/sql";

export const unpaidSale = `s.status = 'completed' AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)`;
const storedChange = "CASE WHEN json_valid(r.proposed_change) THEN r.proposed_change ELSE '{}' END";
const requestSelect = `SELECT r.*, u.username AS requested_by_username, a.username AS reviewed_by_username,
  CASE WHEN r.target_type = 'sale' AND json_extract(${storedChange}, '$.correction_type') = 'sale_cancel'
    AND EXISTS (SELECT 1 FROM sales s WHERE s.id = r.target_id AND ${cancellableSale}) THEN 1
    WHEN r.target_type = 'payment' AND json_extract(${storedChange}, '$.correction_type') IN ('payment_reversal', 'payment_refund')
    AND EXISTS(SELECT 1 FROM payments p JOIN sales s ON s.id = p.sale_id WHERE p.id = r.target_id AND ${adjustablePayment}) THEN 1 ELSE 0 END AS supported
  FROM correction_requests r JOIN users u ON u.id = r.requested_by LEFT JOIN users a ON a.id = r.reviewed_by`;
const unavailable = () => new AuthError(409, "CORRECTION_NOT_PENDING", "Talep artık beklemiyor veya güvenli biçimde uygulanamıyor.");
export const unsupported = () => new AuthError(422, "CORRECTION_UNSUPPORTED", "Talep güvenli biçimde uygulanamıyor. Satış iptalinden önce tüm ödemeler teyitli iade veya hatalı kayıt ters kaydıyla kapatılmalıdır. Tutar/yöntem değiştirme ve kısmi düzeltme desteklenmez.");
type Audit = { entity_id: string; metadata: string };
function verify(audit: Audit | undefined, fingerprint: string) {
  if (!audit) return false;
  if (JSON.parse(audit.metadata).request_hash !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "İşlem anahtarı farklı bilgilerle kullanılmış.");
  return true;
}
export function operationId(actor: string, key: string, action: string) { return `${action}:${tokenHash(actor + ":" + key)}`; }
export function cancellationAudit(session: D1DatabaseSession, operation: string, actor: string, id: string, reason: string,
  now: string, fingerprint: string, attempt: string, condition: string, params: (string | number)[], correctionId: string | null = null) {
  return session.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
    SELECT ?, ?, 'sale.cancelled', 'sale', s.id,
      json_object('reason', ?, 'before', json_object('status', s.status, 'remaining_kurus', s.total_kurus),
        'after', json_object('status', 'cancelled', 'remaining_kurus', 0), 'amount_kurus', s.total_kurus,
        'correction_id', ?, 'approved_by', ?, 'request_hash', ?, 'attempt', ?), ?
    FROM sales s WHERE s.id = ? AND ${unpaidSale} AND (${condition}) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id = ?)`)
    .bind(operation, actor, reason, correctionId, correctionId ? actor : null, fingerprint, attempt, now, id, ...params, operation);
}
export function cancelUpdate(session: D1DatabaseSession, operation: string, attempt: string, now: string) {
  return session.prepare(`UPDATE sales SET status = 'cancelled', updated_at = ? WHERE id = (
    SELECT entity_id FROM audit_logs WHERE id = ? AND json_extract(metadata, '$.attempt') = ?)`)
    .bind(now, operation, attempt);
}
export async function cancelSale(db: D1Database, auth: AuthSession, id: string, key: string, reason: string) {
  const actor = auth.user;
  const now = new Date().toISOString(), earliest = new Date(Date.parse(now) - 300000).toISOString();
  const operation = operationId(actor.id, key, "sale:cancel"), attempt = crypto.randomUUID();
  const fingerprint = tokenHash(JSON.stringify([id, reason]));
  const session = db.withSession("first-primary");
  const result = await authorizedBatch(session, auth, [
    cancellationAudit(session, operation, actor.id, id, reason, now, fingerprint, attempt,
      `? = 'admin' OR (s.created_by = ? AND s.created_at >= ? AND s.created_at <= ?)`, [actor.role, actor.id, earliest, now]),
    cancelUpdate(session, operation, attempt, now),
    session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ?").bind(operation),
  ]);
  if (!verify(result[2]?.results[0] as Audit | undefined, fingerprint)) throw new AuthError(409, "SALE_CANCELLATION_DENIED",
    "Satış iptal edilemedi. Hiç ödeme kaydı bulunmamalı; çalışan yalnızca kendi satışını ilk beş dakika içinde iptal edebilir. Güncel kaydı kontrol edin veya düzeltme talebi oluşturun.");
}
function present(row: Record<string, unknown>, history: unknown[] = [], financial_preview: unknown = null, adjustment: unknown = null, cancellation_preview: unknown = null) {
  let change: Record<string, unknown> = {};
  try { change = JSON.parse(String(row.proposed_change)) ?? {}; } catch { /* Older requests remain visible, never approvable. */ }
  const { proposed_change: _change, supported, ...rest } = row;
  void _change;
  return { ...rest, status: String(row.status), correction_type: typeof change.correction_type === "string" ? change.correction_type : "legacy",
    requested_change: typeof change.requested_change === "string" ? change.requested_change : String(row.proposed_change ?? ""),
    can_approve: row.status === "pending" && supported === 1,
    approval_explanation: row.status !== "pending" ? "Talep sonuçlandırıldı." : (financial_preview as { sale_type?: string } | null)?.sale_type === "walk_in" ? "Tam finansal düzeltme hızlı satışı aynı işlemde iptal eder; müşteri borcu oluşmaz. Harici iade için fiilen ödeme teyidi gerekir." : supported === 1 ? (row.target_type === "payment" ? "Tam tutar ters çevrilir; aktif satışın ve müşterinin borcu aynı tutarda artar. Harici iade, yalnızca adminin fiilen gerçekleştiğine dair teyidiyle kaydedilir." : "Tüm ödemeleri finansal olarak kapatılmış satış iptal edilir; satış borcu kapanır.")
      : "Bu talep onaylanamaz. Önce ödemeleri teyitli iade veya hatalı kayıt ters kaydıyla kapatın. Eski türü belirsiz ters kayıt, kısmi düzeltme ve doğrudan tutar/yöntem değişikliği desteklenmez.", financial_preview, adjustment, cancellation_preview, history };
}
export async function getCorrection(db: D1Database, actor: PublicUser, id: string) {
  const session = db.withSession("first-primary");
  const results = await session.batch<Record<string, unknown>>([
    session.prepare(`${requestSelect} WHERE r.id = ? AND (? = 'admin' OR r.requested_by = ?)`).bind(id, actor.role, actor.id),
    session.prepare(`SELECT a.action, a.actor_user_id, u.username, a.created_at, a.metadata FROM audit_logs a JOIN users u ON u.id = a.actor_user_id
      WHERE a.entity_type = 'correction_request' AND a.entity_id = ? ORDER BY a.created_at, a.id`).bind(id),
    session.prepare(previewSelect).bind(id),
    session.prepare(`${adjustmentSelect} WHERE f.correction_request_id = ?`).bind(id),
    session.prepare(`${balancesCte} SELECT s.id AS sale_id, s.total_kurus AS amount_kurus, b.remaining_kurus AS before_sale_remaining_kurus,
      0 AS after_sale_remaining_kurus, d.total AS before_customer_debt_kurus, d.total - b.remaining_kurus AS after_customer_debt_kurus
      FROM correction_requests r JOIN sales s ON s.id = r.target_id JOIN balances b ON b.id = s.id
      JOIN (SELECT customer_id, sum(remaining_kurus) AS total FROM balances WHERE status='completed' GROUP BY customer_id) d ON d.customer_id=s.customer_id
      WHERE r.id=? AND r.target_type='sale' AND r.status='pending' AND s.status='completed'
        AND json_extract(${storedChange}, '$.correction_type')='sale_cancel'`).bind(id),
  ]);
  const row = results[0]?.results[0];
  if (!row) throw new AuthError(404, "CORRECTION_NOT_FOUND", "Düzeltme talebi bulunamadı.");
  const preview = presentPreview(results[2]?.results[0]);
  if (row.target_type === "payment" && row.status === "pending" && !preview) row.supported = 0;
  const cancellation = results[4]?.results[0] ?? null;
  if (cancellation) for (const key of Object.keys(cancellation)) if (key.endsWith('_kurus')) safeMoney(cancellation[key]);
  return present(row, (results[1]?.results ?? []).map(log => ({ ...log, metadata: JSON.parse(String(log.metadata)) })), preview, results[3]?.results[0] ?? null, cancellation);
}
export async function listCorrections(db: D1Database, actor: PublicUser, query: CorrectionQuery) {
  const where = `WHERE (? = 'admin' OR r.requested_by = ?) AND (? = 'all' OR r.status = ?)`;
  const params = [actor.role, actor.id, query.status, query.status];
  const session = db.withSession("first-primary");
  const results = await session.batch<Record<string, unknown>>([
    session.prepare(`SELECT count(*) AS total FROM correction_requests r ${where}`).bind(...params),
    session.prepare(`${requestSelect} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  return { data: results[1]?.results.map(row => present(row)), pagination: pageInfo(query, Number(results[0]?.results[0]?.total)) };
}
export async function createCorrection(db: D1Database, auth: AuthSession, key: string, input: CreateCorrection) {
  const actor = auth.user;
  const id = crypto.randomUUID(), now = new Date().toISOString(), operation = operationId(actor.id, key, "correction:create");
  const fingerprint = tokenHash(JSON.stringify([input.target_type, input.target_id, input.correction_type, input.reason, input.requested_change]));
  const session = db.withSession("first-primary");
  const results = await authorizedBatch(session, auth, [
    session.prepare(`INSERT INTO correction_requests(id, target_type, target_id, requested_by, reason, proposed_change, status, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ? WHERE
        ((? = 'sale' AND EXISTS(SELECT 1 FROM sales WHERE id = ?)) OR (? = 'payment' AND EXISTS(SELECT 1 FROM payments WHERE id = ?)))
        AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id = ?)`)
      .bind(id, input.target_type, input.target_id, actor.id, input.reason, JSON.stringify({ correction_type: input.correction_type, requested_change: input.requested_change }), now,
        input.target_type, input.target_id, input.target_type, input.target_id, operation),
    session.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, requested_by, 'correction.requested', 'correction_request', id,
        json_object('reason', reason, 'target_type', target_type, 'target_id', target_id, 'before', NULL, 'after', 'pending', 'request_hash', ?), ?
      FROM correction_requests WHERE id = ?`).bind(operation, fingerprint, now, id),
    session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ?").bind(operation),
  ]);
  const audit = results[2]?.results[0] as Audit | undefined;
  if (!verify(audit, fingerprint) || !audit) throw new AuthError(404, "CORRECTION_TARGET_NOT_FOUND", "Düzeltilecek kayıt bulunamadı.");
  return { data: await getCorrection(db, actor, audit.entity_id), created: results[0]?.meta.changes === 1 };
}
export async function reviewCorrection(db: D1Database, auth: AuthSession, id: string, key: string, reason: string, approve: boolean, body?: ApprovalBody) {
  const actor = auth.user;
  if (actor.role !== "admin") throw forbidden();
  if (approve) {
    const current = await getCorrection(db, actor, id);
    if (["payment_reversal", "payment_refund"].includes(current.correction_type)) {
      await approveFinancial(db, auth, id, key, body ?? { reason });
      return getCorrection(db, actor, id);
    }
    if (body && Object.keys(body).some(field => field !== "reason")) throw new AuthError(400, "INVALID_CORRECTION_INPUT", "Bu talep için finansal onay alanları geçersiz.");
  }
  const action = approve ? "approved" : "rejected", operation = operationId(actor.id, key, `correction:${action}`);
  const attempt = crypto.randomUUID(), now = new Date().toISOString(), fingerprint = tokenHash(JSON.stringify([id, reason]));
  const session = db.withSession("first-primary");
  const statements = [session.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
    SELECT ?, ?, ?, 'correction_request', r.id, json_object('reason', ?, 'target_type', r.target_type, 'target_id', r.target_id,
      'before', r.status, 'after', ?, 'approved_by', ?, 'request_hash', ?, 'attempt', ?), ? FROM correction_requests r
    WHERE r.id = ? AND r.status = 'pending' AND (? = 0 OR (r.target_type = 'sale' AND json_valid(r.proposed_change)
      AND json_extract(${storedChange}, '$.correction_type') = 'sale_cancel'
      AND EXISTS (SELECT 1 FROM sales s WHERE s.id = r.target_id AND ${cancellableSale})))
      AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id = ?)`)
    .bind(operation, actor.id, `correction.${action}`, reason, action, approve ? actor.id : null, fingerprint, attempt, now, id, approve ? 1 : 0, operation)];
  if (approve) {
    // All predicates, both audit inserts and state changes share a single transaction with collections.
    statements.push(session.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'sale.cancelled', 'sale', s.id, json_object('reason', ?, 'before', json_object('status', s.status, 'remaining_kurus', s.total_kurus),
        'after', json_object('status', 'cancelled', 'remaining_kurus', 0), 'amount_kurus', s.total_kurus,
        'correction_id', r.id, 'approved_by', ?, 'request_hash', ?, 'attempt', ?),
        max(?, s.created_at, coalesce((SELECT max(p.created_at) FROM payments p WHERE p.sale_id=s.id), s.created_at))
      FROM sales s JOIN correction_requests r ON r.target_id = s.id JOIN audit_logs a ON a.entity_id = r.id
      WHERE a.id = ? AND json_extract(a.metadata, '$.attempt') = ? AND ${cancellableSale}`)
      .bind(operation + ":sale", actor.id, reason, actor.id, fingerprint, attempt, now, operation, attempt));
    statements.push(cancelUpdate(session, operation + ":sale", attempt, now));
  }
  statements.push(session.prepare(`UPDATE correction_requests SET status = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ? AND EXISTS(SELECT 1 FROM audit_logs WHERE id = ? AND json_extract(metadata, '$.attempt') = ?)`)
    .bind(action, actor.id, now, id, operation, attempt));
  statements.push(session.prepare("SELECT entity_id, metadata FROM audit_logs WHERE id = ?").bind(operation));
  const results = await authorizedBatch(session, auth, statements);
  if (!verify(results.at(-1)?.results[0] as Audit | undefined, fingerprint)) {
    const current = await getCorrection(db, actor, id);
    if (current.status !== "pending") throw unavailable();
    if (approve) throw unsupported();
    throw unavailable();
  }
  return getCorrection(db, actor, id);
}
