import { z } from "zod";
import { OpenAPIRoute } from "chanfana";
import { AuthError } from "../auth/errors";
import type { AppContext } from "../types";
import { adjustmentSelect } from "../corrections/financial";
import { pagination, pageSchema } from "./schemas";
import { pageInfo } from "./payments";
import { money } from "../sales/schemas";
import { safeMoney } from "./sql";

const optional = <S extends z.ZodType>(schema: S) => z.preprocess(value => value === null || value === "" ? undefined : value, schema.optional());
export const adjustmentQuery = pagination.extend({ customer_id: optional(z.uuid()), sale_id: optional(z.uuid()), created_by: optional(z.uuid()),
  kind: optional(z.enum(["record_reversal", "external_refund"])), from: optional(z.iso.datetime()), to: optional(z.iso.datetime()) })
  .refine(value => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to));
export const adjustmentSchema = z.object({ id: z.string(), correction_request_id: z.string(), payment_id: z.string(), reversal_payment_id: z.string(),
  sale_id: z.string(), customer_id: z.string(), customer_name: z.string(), kind: z.enum(["record_reversal", "external_refund"]), amount_kurus: money,
  method: z.enum(["cash", "card", "bank"]), reason: z.string(), requested_by: z.string(), requested_by_username: z.string(),
  performed_by: z.string(), performed_by_username: z.string(), approved_by: z.string(), approved_by_username: z.string(),
  before_sale_remaining_kurus: money, after_sale_remaining_kurus: money, before_customer_debt_kurus: money, after_customer_debt_kurus: money,
  external_reference: z.string().nullable(), external_confirmed_at: z.string().nullable(), created_at: z.string() });
export const adjustmentTotalsSchema = z.object({ record_reversal_kurus: money, record_reversal_count: money, external_refund_kurus: money, external_refund_count: money,
  reversal_cash_kurus: money, reversal_card_kurus: money, reversal_bank_kurus: money,
  refund_cash_kurus: money, refund_card_kurus: money, refund_bank_kurus: money });
export const adjustmentAggregate = `coalesce(sum(CASE WHEN kind='record_reversal' THEN amount_kurus ELSE 0 END),0) AS record_reversal_kurus,
  coalesce(sum(CASE WHEN kind='record_reversal' THEN 1 ELSE 0 END),0) AS record_reversal_count,
  coalesce(sum(CASE WHEN kind='external_refund' THEN amount_kurus ELSE 0 END),0) AS external_refund_kurus,
  coalesce(sum(CASE WHEN kind='external_refund' THEN 1 ELSE 0 END),0) AS external_refund_count,
  ${(['cash', 'card', 'bank'] as const).flatMap(method => (["record_reversal", "external_refund"] as const).map(kind =>
    `coalesce(sum(CASE WHEN kind='${kind}' AND method='${method}' THEN amount_kurus ELSE 0 END),0) AS ${kind === 'record_reversal' ? 'reversal' : 'refund'}_${method}_kurus`)).join(', ')}`;
export function adjustmentTotals(session: D1DatabaseSession, from: string, to: string, actor?: string) {
  return session.prepare(`SELECT ${adjustmentAggregate} FROM financial_adjustments WHERE created_at>=? AND created_at<?${actor ? ' AND performed_by=?' : ''}`)
    .bind(...(actor ? [from, to, actor] : [from, to]));
}
export class AdjustmentList extends OpenAPIRoute {
  schema = { tags: ["Financial adjustments"], summary: "Tam ters kayıt ve admin teyitli harici iade geçmişi", request: { query: adjustmentQuery },
    responses: { "200": { description: "Orijinal tahsilatlardan ayrı düzeltmeler", content: { "application/json": { schema: z.object({ data: z.array(adjustmentSchema), pagination: pageSchema }) } } } } };
  async handle(c: AppContext) {
    const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw new AuthError(400, "INVALID_FINANCE_INPUT", "Finansal hareket filtrelerini kontrol edin."); });
    if (query.created_by && c.get('auth').user.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', 'Bu rapor için admin yetkisi gerekli.');
    const terms: string[] = [], params: string[] = [];
    for (const field of ['customer_id', 'sale_id', 'kind'] as const) if (query[field]) { terms.push(`f.${field}=?`); params.push(query[field]); }
    if (query.created_by) { terms.push('f.performed_by=?'); params.push(query.created_by); }
    if (query.from) { terms.push('f.created_at>=?'); params.push(new Date(query.from).toISOString()); }
    if (query.to) { terms.push('f.created_at<?'); params.push(new Date(query.to).toISOString()); }
    const where = terms.length ? `WHERE ${terms.join(' AND ')}` : '', session = c.env.DB.withSession('first-primary');
    const result = await session.batch<Record<string, unknown>>([
      session.prepare(`SELECT count(*) AS total FROM financial_adjustments f ${where}`).bind(...params),
      session.prepare(`${adjustmentSelect} ${where} ORDER BY f.created_at DESC,f.id DESC LIMIT ? OFFSET ?`).bind(...params, query.pageSize, (query.page - 1) * query.pageSize),
    ]);
    return c.json({ data: result[1]!.results.map(row => {
      for (const key of Object.keys(row)) if (key.endsWith('_kurus')) safeMoney(row[key]);
      return row;
    }), pagination: pageInfo(query, safeMoney(result[0]!.results[0]!.total)) });
  }
}
