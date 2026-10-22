import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError } from "../auth/errors";
import { customerParams } from "../customers/schemas";
import { createPaymentSchema, paymentQuery, paymentSchema, pageSchema, pagination, debtQuery, debtRowSchema,
  customerDebtSchema, ledgerQuery, ledgerRowSchema, summarySchema, customerSchema } from "./schemas";
import { createPayment, listPayments } from "./payments";
import { customerLedger, customerReceivables, listReceivables } from "./receivables";
const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const invalid = () => new AuthError(400, "INVALID_FINANCE_INPUT", "Müşteriyi, satışı, tutarı, yöntemi ve filtreleri kontrol edin.");
const receipt = { description: "Tahsilat", ...json(z.object({ data: paymentSchema })) };
export class PaymentCreate extends OpenAPIRoute {
  schema = { tags: ["Payments"], summary: "Ortak satışa sonradan tahsilat", request: { headers: z.object({ "idempotency-key": z.uuid() }), body: { required: true, ...json(createPaymentSchema) } },
    responses: { "201": receipt, "200": { ...receipt, description: "Aynı işlemin tekrar yanıtı" } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const result = await createPayment(c.env.DB, c.get("auth").user.id, data.headers["idempotency-key"], data.body);
    return c.json({ data: result.payment }, result.created ? 201 : 200);
  }
}
export class PaymentList extends OpenAPIRoute {
  schema = { tags: ["Payments"], summary: "Ortak tahsilat geçmişi (ilk ödemeler dahil)", request: { query: paymentQuery },
    responses: { "200": { description: "Tahsilatlar", ...json(z.object({ data: z.array(paymentSchema), pagination: pageSchema })) } } };
  async handle(c: AppContext) { const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await listPayments(c.env.DB, data.query)); }
}
export class ReceivableList extends OpenAPIRoute {
  schema = { tags: ["Receivables"], summary: "Borçlu müşteriler", request: { query: debtQuery },
    responses: { "200": { description: "Borçlu listesi", ...json(z.object({ data: z.array(debtRowSchema), pagination: pageSchema })) } } };
  async handle(c: AppContext) { const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await listReceivables(c.env.DB, data.query)); }
}
export class CustomerReceivables extends OpenAPIRoute {
  schema = { tags: ["Receivables"], summary: "Müşterinin toplam borcu ve açık satışları", request: { params: customerParams, query: pagination },
    responses: { "200": { description: "Açık satışlar", ...json(customerDebtSchema) } } };
  async handle(c: AppContext) { const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await customerReceivables(c.env.DB, data.params.id, data.query)); }
}
export class CustomerLedger extends OpenAPIRoute {
  schema = { tags: ["Receivables"], summary: "Müşterinin finansal hareket geçmişi", request: { params: customerParams, query: ledgerQuery },
    responses: { "200": { description: "Hareketler", ...json(z.object({ customer: customerSchema, summary: summarySchema, data: z.array(ledgerRowSchema), pagination: pageSchema })) } } };
  async handle(c: AppContext) { const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await customerLedger(c.env.DB, data.params.id, data.query)); }
}
