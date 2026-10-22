import { missingCustomer } from "../customers/repository";
import { presentSale, summarySelect, type SummaryRow } from "../sales/repository";
import { balancesCte, safeBalance, safeMoney, validPayment } from "./sql";
import { pageInfo } from "./payments";
import type { DebtQuery, LedgerQuery, PageQuery } from "./schemas";

const summary = `SELECT coalesce(sum(CASE WHEN status = 'completed' THEN remaining_kurus ELSE 0 END), 0) AS total_debt_kurus,
  coalesce(sum(CASE WHEN status = 'completed' AND remaining_kurus > 0 THEN 1 ELSE 0 END), 0) AS open_sales_count,
  (SELECT max(p.created_at) FROM payments p WHERE p.customer_id = ? AND ${validPayment}) AS last_payment_at
  FROM balances WHERE customer_id = ?`;
function summaryRow(row: Record<string, unknown>) { safeMoney(row.total_debt_kurus); return row; }
function customerRow(result: D1Result | undefined) { const customer = result?.results[0]; if (!customer) throw missingCustomer(); return customer; }

export async function customerReceivables(db: D1Database, id: string, query: PageQuery) {
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare("SELECT id, name, phone FROM customers WHERE id = ?").bind(id),
    session.prepare(`${balancesCte} ${summary}`).bind(id, id),
    session.prepare(`${balancesCte} ${summarySelect} JOIN balances b ON b.id = s.id
      WHERE s.customer_id = ? AND s.status = 'completed' AND b.remaining_kurus > 0
      ORDER BY s.created_at, s.id LIMIT ? OFFSET ?`).bind(id, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  const info = summaryRow(results[1]?.results[0] as Record<string, unknown>);
  return { customer: customerRow(results[0]), summary: info, data: (results[2]?.results as SummaryRow[]).map(presentSale),
    pagination: pageInfo(query, Number(info.open_sales_count)) };
}

export async function listReceivables(db: D1Database, query: DebtQuery) {
  let name = "c.name";
  for (const [upper, lower] of [["İ", "i"], ["I", "ı"], ["Ğ", "ğ"], ["Ü", "ü"], ["Ş", "ş"], ["Ö", "ö"], ["Ç", "ç"]]) name = `replace(${name}, '${upper}', '${lower}')`;
  const where = query.q ? `AND instr(lower(${name}), ?) > 0` : "";
  const params = query.q ? [query.q.toLocaleLowerCase("tr-TR")] : [];
  const cte = `${balancesCte}, debtors AS (
    SELECT c.id, c.name, c.phone, sum(b.remaining_kurus) AS total_debt_kurus, count(*) AS open_sales_count,
      (SELECT max(p.created_at) FROM payments p WHERE p.customer_id = c.id AND ${validPayment}) AS last_payment_at
    FROM customers c JOIN balances b ON b.customer_id = c.id
    WHERE b.status = 'completed' AND b.remaining_kurus > 0 ${where} GROUP BY c.id
  )`;
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare(`${cte} SELECT count(*) AS total FROM debtors`).bind(...params),
    session.prepare(`${cte} SELECT * FROM debtors ORDER BY total_debt_kurus DESC, id LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  return { data: (results[1]?.results as Record<string, unknown>[]).map(summaryRow),
    pagination: pageInfo(query, (results[0]?.results[0] as { total: number }).total) };
}

export async function customerLedger(db: D1Database, id: string, query: LedgerQuery) {
  const terms: string[] = [], params: string[] = [];
  if (query.type !== "all") { terms.push("type = ?"); params.push(query.type); }
  if (query.from) { terms.push("created_at >= ?"); params.push(new Date(query.from).toISOString()); }
  if (query.to) { terms.push("created_at < ?"); params.push(new Date(query.to).toISOString()); }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
  // Running balances are computed over the full history BEFORE filters/pagination, with deterministic ties.
  const cte = `WITH customer_sales AS (SELECT s.*,
    CASE WHEN s.status = 'completed' OR EXISTS(SELECT 1 FROM audit_logs a WHERE a.entity_type = 'sale' AND a.entity_id = s.id AND a.action = 'sale.cancelled')
      THEN 1 ELSE 0 END AS tracked FROM sales s WHERE customer_id = ?), movements AS (
    SELECT 'sale:' || s.id AS id, 'sale' AS type, s.id AS sale_id, s.total_kurus AS amount_kurus, NULL AS method,
      s.created_at, s.created_by, u.username AS created_by_username, 0 AS event_order,
      s.tracked AS effective, CASE WHEN s.tracked = 1 THEN s.total_kurus ELSE 0 END AS delta
    FROM customer_sales s JOIN users u ON u.id = s.created_by
    UNION ALL
    SELECT 'payment:' || p.id, CASE WHEN p.reversal_of_payment_id IS NULL THEN 'payment' ELSE 'reversal' END,
      s.id, p.amount_kurus, p.method, p.created_at, p.created_by, u.username,
      CASE WHEN p.reversal_of_payment_id IS NULL THEN 1 ELSE 2 END,
      CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END,
      CASE WHEN s.status <> 'completed' THEN 0 WHEN p.reversal_of_payment_id IS NULL THEN -p.amount_kurus ELSE p.amount_kurus END
    FROM payments p JOIN customer_sales s ON s.id = p.sale_id JOIN users u ON u.id = p.created_by
    UNION ALL
    SELECT 'cancellation:' || a.id, 'cancellation', s.id, s.total_kurus, NULL, a.created_at, a.actor_user_id, u.username,
      3, 1, -s.total_kurus FROM audit_logs a JOIN customer_sales s ON s.id = a.entity_id JOIN users u ON u.id = a.actor_user_id
      WHERE a.entity_type = 'sale' AND a.action = 'sale.cancelled'
  ), history AS (
    SELECT id, type, sale_id, amount_kurus, method, created_at, created_by, created_by_username, effective,
      sum(delta) OVER (ORDER BY created_at, event_order, id ROWS UNBOUNDED PRECEDING) AS balance_after_kurus,
      sum(delta) OVER (PARTITION BY sale_id ORDER BY created_at, event_order, id ROWS UNBOUNDED PRECEDING) AS sale_balance_after_kurus,
      event_order FROM movements
  )`;
  const session = db.withSession("first-primary");
  const results = await session.batch([
    session.prepare("SELECT id, name, phone FROM customers WHERE id = ?").bind(id),
    session.prepare(`${balancesCte} ${summary}`).bind(id, id),
    session.prepare(`${cte} SELECT count(*) AS total FROM history ${where}`).bind(id, ...params),
    session.prepare(`${cte} SELECT id, type, sale_id, amount_kurus, method, created_at, created_by, created_by_username,
      effective, balance_after_kurus, sale_balance_after_kurus FROM history ${where}
      ORDER BY created_at DESC, event_order DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(id, ...params, query.pageSize, (query.page - 1) * query.pageSize),
  ]);
  return { customer: customerRow(results[0]), summary: summaryRow(results[1]?.results[0] as Record<string, unknown>),
    data: (results[3]?.results as Record<string, unknown>[]).map(row => {
      safeMoney(row.amount_kurus); safeBalance(row.balance_after_kurus); safeBalance(row.sale_balance_after_kurus);
      return { ...row, effective: row.effective === 1 };
    }), pagination: pageInfo(query, (results[2]?.results[0] as { total: number }).total) };
}
