import { adjustmentTotals, adjustmentAggregate } from "../finance/adjustments";
import { pageInfo, paymentSelect, presentPayment } from "../finance/payments";
import { balancesCte, safeMoney, validPayment } from "../finance/sql";
import { debtorsQuery, turkishName } from "../finance/receivables";
import { presentSale, summarySelect, type SummaryRow } from "../sales/repository";
import { reportRange, type ReportRange } from "./range";
import type { ReportQuery } from "./schemas";

type Row = Record<string, unknown>;
function safeRow(row: Row) {
  for (const [key, value] of Object.entries(row)) if (key.endsWith("_kurus") || key.endsWith("_count") || key === "quantity") safeMoney(value);
  return row;
}
function timeFilter(alias: string, range: ReportRange, actor?: string) {
  return { sql: `${alias}.created_at >= ? AND ${alias}.created_at < ?${actor ? ` AND ${alias}.created_by = ?` : ""}`,
    params: actor ? [range.from, range.to, actor] : [range.from, range.to] };
}
function search(q: string, column: string) { return { sql: q ? ` AND instr(${turkishName(column)}, ?) > 0` : "", params: q ? [q.toLocaleLowerCase("tr-TR")] : [] }; }
function saleTotals(session: D1DatabaseSession, range: ReportRange, actor?: string) {
  const time = timeFilter("s", range, actor);
  return session.prepare(`SELECT coalesce(sum(CASE WHEN status = 'completed' THEN total_kurus ELSE 0 END),0) AS sales_total_kurus,
    coalesce(sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),0) AS sales_count,
    coalesce(sum(CASE WHEN status = 'cancelled' THEN total_kurus ELSE 0 END),0) AS cancelled_total_kurus,
    coalesce(sum(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),0) AS cancelled_count FROM sales s WHERE ${time.sql}`).bind(...time.params);
}
function paymentTotals(session: D1DatabaseSession, range: ReportRange, actor?: string) {
  const time = timeFilter("p", range, actor);
  return session.prepare(`SELECT coalesce(sum(p.amount_kurus),0) AS payments_total_kurus, count(*) AS payments_count,
    coalesce(sum(CASE WHEN p.method='cash' THEN p.amount_kurus ELSE 0 END),0) AS cash_kurus,
    coalesce(sum(CASE WHEN p.method='card' THEN p.amount_kurus ELSE 0 END),0) AS card_kurus,
    coalesce(sum(CASE WHEN p.method='bank' THEN p.amount_kurus ELSE 0 END),0) AS bank_kurus
    FROM payments p WHERE ${time.sql} AND ${validPayment}`).bind(...time.params);
}
const debtSummary = `SELECT coalesce(sum(total_debt_kurus),0) AS total_debt_kurus, count(*) AS debtor_count,
  coalesce(sum(open_sales_count),0) AS open_sales_count, coalesce(sum(sales_total_kurus),0) AS sales_total_kurus,
  coalesce(sum(paid_kurus),0) AS paid_kurus FROM debtors`;
export async function reportSummary(db: D1Database, query: ReportQuery) {
  const range = reportRange(query), session = db.withSession("first-primary"), debt = debtorsQuery("", true);
  // Each financial measure uses its own source/date, without joining sales x items x payments.
  const results = await session.batch<Row>([
    saleTotals(session, range), paymentTotals(session, range), session.prepare(`${debt.cte} ${debtSummary}`),
    session.prepare(`SELECT * FROM (
      SELECT 'sale:'||s.id AS id, 'sale' AS type, s.id AS sale_id, s.customer_id, coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri') AS customer_name,
        s.total_kurus AS amount_kurus, s.created_by, u.username AS created_by_username, s.created_at, s.status
      FROM sales s LEFT JOIN customers c ON c.id=s.customer_id JOIN users u ON u.id=s.created_by WHERE s.created_at>=? AND s.created_at<?
      UNION ALL
      SELECT 'payment:'||p.id, 'payment', p.sale_id, p.customer_id, coalesce(c.name,(SELECT walk_in_customer_name FROM sales WHERE id=p.sale_id),'Misafir Müşteri'), p.amount_kurus, p.created_by, u.username, p.created_at, 'valid'
      FROM payments p LEFT JOIN customers c ON c.id=p.customer_id JOIN users u ON u.id=p.created_by WHERE p.created_at>=? AND p.created_at<? AND ${validPayment}
      UNION ALL
      SELECT 'cancellation:'||a.id, 'cancellation', s.id, s.customer_id, coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri'), s.total_kurus, a.actor_user_id, u.username, a.created_at, 'cancelled'
      FROM audit_logs a JOIN sales s ON s.id=a.entity_id LEFT JOIN customers c ON c.id=s.customer_id JOIN users u ON u.id=a.actor_user_id
      WHERE a.created_at>=? AND a.created_at<? AND a.action='sale.cancelled' AND a.entity_type='sale'
      UNION ALL
      SELECT 'adjustment:'||f.id, f.kind, f.sale_id, f.customer_id, coalesce(c.name,(SELECT walk_in_customer_name FROM sales WHERE id=f.sale_id),'Misafir Müşteri'), f.amount_kurus, f.performed_by, u.username, f.created_at, 'approved'
      FROM financial_adjustments f LEFT JOIN customers c ON c.id=f.customer_id JOIN users u ON u.id=f.performed_by WHERE f.created_at>=? AND f.created_at<?
    ) ORDER BY created_at DESC, id DESC LIMIT 10`).bind(range.from, range.to, range.from, range.to, range.from, range.to, range.from, range.to),
    adjustmentTotals(session, range.from, range.to),
  ]);
  return { range, sales: safeRow(results[0]!.results[0]!), payments: safeRow(results[1]!.results[0]!),
    adjustments: safeRow(results[4]!.results[0]!), receivables: safeRow(results[2]!.results[0]!), recent: results[3]!.results.map(safeRow) };
}
export async function reportSales(db: D1Database, query: ReportQuery) {
  const range = reportRange(query), session = db.withSession("first-primary"), time = timeFilter("s", range, query.created_by);
  const productView = query.view === "products", itemView = query.view === "items";
  const match = search(query.q, productView ? "i.product_name_snapshot" : "coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri')");
  const status = query.view === "cancelled" ? "cancelled" : "completed";
  const params = [...time.params, status, ...match.params];
  const where = `WHERE ${time.sql} AND s.status=?${match.sql}`;
  let count: string, list: string;
  if (productView) {
    const grouped = `SELECT i.product_id, i.product_name_snapshot, i.unit_price_kurus, sum(i.quantity) AS quantity, sum(i.line_total_kurus) AS total_kurus
      FROM sale_items i JOIN sales s ON s.id=i.sale_id ${where} GROUP BY i.product_id, i.product_name_snapshot, i.unit_price_kurus`;
    count = `SELECT count(*) AS total FROM (${grouped})`;
    list = `SELECT * FROM (${grouped}) ORDER BY total_kurus DESC, product_id, product_name_snapshot, unit_price_kurus`;
  } else if (itemView) {
    const from = `FROM sale_items i JOIN sales s ON s.id=i.sale_id LEFT JOIN customers c ON c.id=s.customer_id JOIN users u ON u.id=s.created_by ${where}`;
    count = `SELECT count(*) AS total ${from}`;
    list = `SELECT i.id,i.sale_id,i.product_id,i.product_name_snapshot,i.unit_price_kurus,i.quantity,i.line_total_kurus,
      s.created_at,u.username AS created_by_username,coalesce(c.name,s.walk_in_customer_name,'Misafir Müşteri') AS customer_name ${from} ORDER BY s.created_at DESC,s.id DESC,i.id`;
  } else {
    count = `SELECT count(*) AS total FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ${where}`;
    list = `${summarySelect} ${where} ORDER BY s.created_at DESC,s.id DESC`;
  }
  const results = await session.batch<Row>([saleTotals(session, range, query.created_by), session.prepare(count).bind(...params),
    session.prepare(list + " LIMIT ? OFFSET ?").bind(...params, query.pageSize, (query.page - 1) * query.pageSize)]);
  return { range, summary: safeRow(results[0]!.results[0]!), view: query.view,
    data: results[2]!.results.map(row => productView || itemView ? safeRow(row) : presentSale(row as SummaryRow)),
    pagination: pageInfo(query, safeMoney(results[1]!.results[0]!.total)) };
}
export async function reportPayments(db: D1Database, query: ReportQuery) {
  const range = reportRange(query), session = db.withSession("first-primary"), time = timeFilter("p", range, query.created_by), match = search(query.q, "coalesce(c.name,(SELECT walk_in_customer_name FROM sales WHERE id=p.sale_id),'Misafir Müşteri')");
  const where = `WHERE ${time.sql} AND ${validPayment}${match.sql}`, params = [...time.params, ...match.params];
  const results = await session.batch<Row>([paymentTotals(session, range, query.created_by),
    session.prepare(`SELECT count(*) AS total FROM payments p LEFT JOIN customers c ON c.id=p.customer_id ${where}`).bind(...params),
    session.prepare(`${balancesCte} ${paymentSelect} ${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
    adjustmentTotals(session, range.from, range.to, query.created_by)]);
  return { range, adjustments: safeRow(results[3]!.results[0]!), summary: safeRow(results[0]!.results[0]!), data: results[2]!.results.map(presentPayment), pagination: pageInfo(query, safeMoney(results[1]!.results[0]!.total)) };
}
export async function reportReceivables(db: D1Database, query: ReportQuery) {
  const range = reportRange(query), session = db.withSession("first-primary"), all = debtorsQuery("", true), filtered = debtorsQuery(query.q, true);
  const results = await session.batch<Row>([session.prepare(`${all.cte} ${debtSummary}`),
    session.prepare(`${filtered.cte} SELECT count(*) AS total FROM debtors`).bind(...filtered.params),
    session.prepare(`${filtered.cte} SELECT * FROM debtors ORDER BY total_debt_kurus DESC,id LIMIT ? OFFSET ?`)
      .bind(...filtered.params, query.pageSize, (query.page - 1) * query.pageSize)]);
  return { range, balance_scope: "current" as const, summary: safeRow(results[0]!.results[0]!), data: results[2]!.results.map(safeRow), pagination: pageInfo(query, safeMoney(results[1]!.results[0]!.total)) };
}
export async function reportEmployees(db: D1Database, query: ReportQuery) {
  const range = reportRange(query), session = db.withSession("first-primary"), match = search(query.q, "u.username");
  const cte = `WITH sold AS (SELECT created_by,
    sum(CASE WHEN status='completed' THEN total_kurus ELSE 0 END) AS sales_total_kurus, sum(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS sales_count,
    sum(CASE WHEN status='cancelled' THEN total_kurus ELSE 0 END) AS cancelled_total_kurus, sum(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_count
    FROM sales WHERE created_at>=? AND created_at<? GROUP BY created_by),
    collected AS (SELECT p.created_by,sum(p.amount_kurus) AS payments_total_kurus,count(*) AS payments_count,
      sum(CASE WHEN p.method='cash' THEN p.amount_kurus ELSE 0 END) AS cash_kurus,
      sum(CASE WHEN p.method='card' THEN p.amount_kurus ELSE 0 END) AS card_kurus,
      sum(CASE WHEN p.method='bank' THEN p.amount_kurus ELSE 0 END) AS bank_kurus FROM payments p
      WHERE p.created_at>=? AND p.created_at<? AND ${validPayment} GROUP BY p.created_by),
    adjusted AS (SELECT performed_by, ${adjustmentAggregate} FROM financial_adjustments WHERE created_at>=? AND created_at<? GROUP BY performed_by),
    workers AS (SELECT u.id,u.username,coalesce(s.sales_total_kurus,0) AS sales_total_kurus,coalesce(s.sales_count,0) AS sales_count,
      coalesce(s.cancelled_total_kurus,0) AS cancelled_total_kurus,coalesce(s.cancelled_count,0) AS cancelled_count,
      coalesce(p.payments_total_kurus,0) AS payments_total_kurus,coalesce(p.payments_count,0) AS payments_count,
      coalesce(p.cash_kurus,0) AS cash_kurus,coalesce(p.card_kurus,0) AS card_kurus,coalesce(p.bank_kurus,0) AS bank_kurus,
      ${['record_reversal_kurus','record_reversal_count','external_refund_kurus','external_refund_count', 'reversal_cash_kurus','reversal_card_kurus','reversal_bank_kurus','refund_cash_kurus','refund_card_kurus','refund_bank_kurus'].map(field => `coalesce(f.${field},0) AS ${field}`).join(', ')}
      FROM users u LEFT JOIN sold s ON s.created_by=u.id LEFT JOIN collected p ON p.created_by=u.id LEFT JOIN adjusted f ON f.performed_by=u.id
      WHERE (s.created_by IS NOT NULL OR p.created_by IS NOT NULL OR f.performed_by IS NOT NULL)${match.sql})`;
  const params = [range.from, range.to, range.from, range.to, range.from, range.to, ...match.params];
  const results = await session.batch<Row>([session.prepare(`${cte} SELECT count(*) AS total FROM workers`).bind(...params),
    session.prepare(`${cte} SELECT * FROM workers ORDER BY sales_total_kurus DESC,id LIMIT ? OFFSET ?`).bind(...params, query.pageSize, (query.page - 1) * query.pageSize)]);
  return { range, data: results[1]!.results.map(safeRow), pagination: pageInfo(query, safeMoney(results[0]!.results[0]!.total)) };
}
