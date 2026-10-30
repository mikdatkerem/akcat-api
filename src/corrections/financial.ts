import type { AuthSession } from "../types";
import { authorizedBatch } from "../security/authorizedBatch";
import { AuthError, forbidden } from "../auth/errors";
import { tokenHash } from "../security/tokens";
import { balancesCte, validPayment, safeMoney } from "../finance/sql";
import type { ApprovalBody } from "./schemas";

// Never infer that an untyped legacy reversal represents an actual refund.
export const cancellableSale = `s.status = 'completed'
  AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.sale_id = s.id AND ${validPayment})
  AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.reversal_of_payment_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM financial_adjustments f JOIN payments v ON v.id = f.reversal_payment_id
      WHERE f.payment_id = p.id AND f.sale_id = s.id AND f.customer_id IS p.customer_id
      AND f.amount_kurus = p.amount_kurus AND v.amount_kurus = p.amount_kurus AND v.method = p.method
      AND v.customer_id IS p.customer_id AND v.sale_id = s.id AND v.reversal_of_payment_id = p.id))`;
export const adjustablePayment = `p.reversal_of_payment_id IS NULL AND ${validPayment}
  AND s.status = 'completed' AND s.customer_id IS p.customer_id
  AND (s.sale_type='normal' OR (p.amount_kurus=s.total_kurus AND 1=(SELECT count(*) FROM payments original WHERE original.sale_id=s.id AND original.reversal_of_payment_id IS NULL)))
  AND NOT EXISTS(SELECT 1 FROM financial_adjustments f WHERE f.payment_id = p.id)
  AND typeof(p.amount_kurus) = 'integer' AND p.amount_kurus BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}`;
export const adjustmentSelect = `SELECT f.*, s.sale_type, coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri') AS customer_name, requester.username AS requested_by_username,
  operator.username AS performed_by_username, approver.username AS approved_by_username
  FROM financial_adjustments f JOIN sales s ON s.id=f.sale_id LEFT JOIN customers c ON c.id = f.customer_id
  JOIN users requester ON requester.id = f.requested_by JOIN users operator ON operator.id = f.performed_by
  JOIN users approver ON approver.id = f.approved_by`;
const debt = `(SELECT coalesce(sum(remaining_kurus), 0) FROM balances WHERE customer_id = p.customer_id AND status = 'completed')`;
export const previewSelect = `${balancesCte} SELECT p.id AS payment_id, p.sale_id, p.customer_id, s.sale_type, coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri') AS customer_name,
  p.amount_kurus, p.method, p.created_at AS original_created_at, u.username AS original_created_by_username,
  b.remaining_kurus AS before_sale_remaining_kurus, CASE WHEN s.sale_type='walk_in' THEN 0 ELSE b.remaining_kurus + p.amount_kurus END AS after_sale_remaining_kurus,
  ${debt} AS before_customer_debt_kurus, CASE WHEN s.sale_type='walk_in' THEN 0 ELSE ${debt} + p.amount_kurus END AS after_customer_debt_kurus,
  CASE WHEN json_extract(r.proposed_change, '$.correction_type') = 'payment_refund' THEN 1 ELSE 0 END AS requires_external_confirmation
  FROM correction_requests r JOIN payments p ON p.id = r.target_id JOIN sales s ON s.id = p.sale_id
  JOIN balances b ON b.id = s.id LEFT JOIN customers c ON c.id = p.customer_id JOIN users u ON u.id = p.created_by
  WHERE r.id = ? AND r.target_type = 'payment' AND r.status = 'pending'
    AND CASE WHEN json_valid(r.proposed_change) THEN json_extract(r.proposed_change, '$.correction_type') ELSE '' END IN ('payment_reversal', 'payment_refund')
    AND ${adjustablePayment} AND b.remaining_kurus >= 0 AND ${debt} >= 0
    AND b.remaining_kurus + p.amount_kurus <= ${Number.MAX_SAFE_INTEGER} AND ${debt} + p.amount_kurus <= ${Number.MAX_SAFE_INTEGER}`;
export function presentPreview(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  for (const key of Object.keys(row)) if (key.endsWith('_kurus')) safeMoney(row[key]);
  return { ...row, requires_external_confirmation: row.requires_external_confirmation === 1 };
}

export async function approveFinancial(db: D1Database, auth: AuthSession, id: string, key: string, body: ApprovalBody) {
  const actor = auth.user;
  if (actor.role !== "admin") throw forbidden();
  if (body.expected_amount_kurus === undefined || body.expected_sale_remaining_kurus === undefined || body.expected_customer_debt_kurus === undefined)
    throw new AuthError(400, "FINANCIAL_PREVIEW_REQUIRED", "Güncel tutarı ve bakiyeleri inceleyerek onaylayın.");
  const operation = `correction:approved:${tokenHash(actor.id + ":" + key)}`, attempt = crypto.randomUUID();
  const fingerprint = tokenHash(JSON.stringify([id, body.reason, body.expected_amount_kurus, body.expected_sale_remaining_kurus,
    body.expected_customer_debt_kurus, body.refund_confirmation ?? null]));
  const now = new Date().toISOString(), reversal = crypto.randomUUID(), adjustment = crypto.randomUUID();
  const session = db.withSession("first-primary");
  const gate = `a.id = ? AND json_extract(a.metadata, '$.attempt') = ?`;
  const results = await authorizedBatch(session, auth, [
    session.prepare(`${balancesCte} INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'correction.approved', 'correction_request', r.id,
        json_object('reason', ?, 'before', 'pending', 'after', 'approved', 'approved_by', ?, 'requested_by', r.requested_by,
          'target_type', 'payment', 'target_id', p.id, 'request_hash', ?, 'attempt', ?,
          'before_sale_remaining_kurus', b.remaining_kurus, 'before_customer_debt_kurus', ${debt}), max(?, p.created_at, s.created_at)
      FROM correction_requests r JOIN payments p ON p.id = r.target_id JOIN sales s ON s.id = p.sale_id JOIN balances b ON b.id = s.id
      WHERE r.id = ? AND r.status = 'pending' AND r.target_type = 'payment' AND ${adjustablePayment}
        AND CASE WHEN json_valid(r.proposed_change) THEN json_extract(r.proposed_change, '$.correction_type') ELSE '' END = ?
        AND p.amount_kurus = ? AND b.remaining_kurus = ? AND ${debt} = ?
        AND b.remaining_kurus >= 0 AND ${debt} >= 0 AND b.remaining_kurus + p.amount_kurus <= ${Number.MAX_SAFE_INTEGER}
        AND ${debt} + p.amount_kurus <= ${Number.MAX_SAFE_INTEGER}
        AND NOT EXISTS(SELECT 1 FROM financial_adjustments WHERE kind = 'external_refund' AND method = p.method AND external_reference = ?)
        AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id = ?)`)
      .bind(operation, actor.id, body.reason, actor.id, fingerprint, attempt, now, id,
        body.refund_confirmation ? 'payment_refund' : 'payment_reversal', body.expected_amount_kurus,
        body.expected_sale_remaining_kurus, body.expected_customer_debt_kurus, body.refund_confirmation?.reference ?? null, operation),
    session.prepare(`INSERT INTO payments(id, customer_id, sale_id, amount_kurus, method, created_by, idempotency_key, reversal_of_payment_id, created_at)
      SELECT ?, p.customer_id, p.sale_id, p.amount_kurus, p.method, ?, ?, p.id, a.created_at
      FROM audit_logs a JOIN payments p ON p.id = json_extract(a.metadata, '$.target_id') WHERE ${gate}`)
      .bind(reversal, actor.id, operation, operation, attempt),
    session.prepare(`INSERT INTO financial_adjustments(id, correction_request_id, payment_id, reversal_payment_id, sale_id, customer_id,
      kind, amount_kurus, method, reason, requested_by, performed_by, approved_by, before_sale_remaining_kurus, after_sale_remaining_kurus,
      before_customer_debt_kurus, after_customer_debt_kurus, external_reference, external_confirmed_at, created_at)
      SELECT ?, r.id, p.id, ?, p.sale_id, p.customer_id, ?, p.amount_kurus, p.method, ?, r.requested_by, ?, ?,
        json_extract(a.metadata, '$.before_sale_remaining_kurus'), CASE WHEN s.sale_type='walk_in' THEN 0 ELSE json_extract(a.metadata, '$.before_sale_remaining_kurus') + p.amount_kurus END,
        json_extract(a.metadata, '$.before_customer_debt_kurus'), CASE WHEN s.sale_type='walk_in' THEN 0 ELSE json_extract(a.metadata, '$.before_customer_debt_kurus') + p.amount_kurus END,
        ?, ?, a.created_at FROM audit_logs a JOIN correction_requests r ON r.id = a.entity_id JOIN payments p ON p.id = r.target_id JOIN sales s ON s.id=p.sale_id WHERE ${gate}`)
      .bind(adjustment, reversal, body.refund_confirmation ? 'external_refund' : 'record_reversal', body.reason, actor.id, actor.id,
        body.refund_confirmation?.reference ?? null, body.refund_confirmation ? now : null, operation, attempt),
    session.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, metadata, created_at)
      SELECT ?, ?, 'payment.' || f.kind, 'financial_adjustment', f.id,
        json_object('reason', f.reason, 'payment_id', f.payment_id, 'reversal_payment_id', f.reversal_payment_id,
          'correction_request_id', f.correction_request_id, 'amount_kurus', f.amount_kurus, 'method', f.method,
          'requested_by', f.requested_by, 'performed_by', f.performed_by, 'approved_by', f.approved_by,
          'before_sale_remaining_kurus', f.before_sale_remaining_kurus, 'after_sale_remaining_kurus', f.after_sale_remaining_kurus,
          'before_customer_debt_kurus', f.before_customer_debt_kurus, 'after_customer_debt_kurus', f.after_customer_debt_kurus,
          'external_reference', f.external_reference, 'external_confirmed_at', f.external_confirmed_at), f.created_at
      FROM financial_adjustments f WHERE f.id = ?`).bind(operation + ':financial', actor.id, adjustment),
    session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      SELECT ?,?,'sale.cancelled','sale',s.id,json_object('reason',f.reason,'before',json_object('status',s.status,'remaining_kurus',0),
        'after',json_object('status','cancelled','remaining_kurus',0),'amount_kurus',s.total_kurus,'correction_id',f.correction_request_id,'approved_by',?,'attempt',?),f.created_at
      FROM financial_adjustments f JOIN sales s ON s.id=f.sale_id WHERE f.id=? AND s.sale_type='walk_in'`)
      .bind(operation+':sale',actor.id,actor.id,attempt,adjustment),
    session.prepare(`UPDATE sales SET status='cancelled',updated_at=? WHERE sale_type='walk_in'
      AND id=(SELECT sale_id FROM financial_adjustments WHERE id=?)
      AND EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND json_extract(metadata,'$.attempt')=?)`)
      .bind(now,adjustment,operation+':sale',attempt),
    session.prepare(`UPDATE correction_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND EXISTS(SELECT 1 FROM financial_adjustments WHERE id = ?)`)
      .bind(actor.id, now, id, adjustment),
    session.prepare("SELECT metadata FROM audit_logs WHERE id = ?").bind(operation),
  ]);
  const audit = results.at(-1)?.results[0] as { metadata: string } | undefined;
  if (!audit) throw new AuthError(409, "FINANCIAL_ADJUSTMENT_DENIED", "İşlem uygulanmadı. Talep, ödeme, bakiye veya harici iade teyidi değişmiş olabilir. Güncel kaydı inceleyin; kısmi ve ikinci ters kayıt desteklenmez.");
  if (JSON.parse(audit.metadata).request_hash !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "İşlem anahtarı farklı bilgilerle kullanılmış.");
}
