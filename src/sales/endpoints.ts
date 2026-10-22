import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError } from "../auth/errors";
import { createSaleSchema, saleQuery, saleParams, saleDetailSchema, saleSummarySchema } from "./schemas";
import { createSale, getSale, listSales } from "./repository";

const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const single = { description: "Satış ve geçerli ödeme hareketleri", ...json(z.object({ data: saleDetailSchema })) };
const invalid = () => new AuthError(400, "INVALID_SALE_INPUT", "Müşteriyi, ürün miktarlarını, ödeme ve filtre alanlarını kontrol edin.");
export class SaleCreate extends OpenAPIRoute {
  schema = { tags: ["Sales"], summary: "Teslim edilmiş satış ve varsa ilk ödeme", request: {
    headers: z.object({ "idempotency-key": z.uuid() }), body: { required: true, ...json(createSaleSchema) },
  }, responses: { "201": single, "200": { ...single, description: "Aynı işlemin tekrar yanıtı" } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const result = await createSale(c.env.DB, c.get("auth").user.id, data.headers["idempotency-key"], data.body);
    return c.json({ data: result.sale }, result.created ? 201 : 200);
  }
}
export class SaleList extends OpenAPIRoute {
  schema = { tags: ["Sales"], summary: "Ortak işletme satış geçmişi", request: { query: saleQuery }, responses: {
    "200": { description: "Satış listesi", ...json(z.object({ data: z.array(saleSummarySchema),
      pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }) })) },
  } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json(await listSales(c.env.DB, data.query));
  }
}
export class SaleGet extends OpenAPIRoute {
  schema = { tags: ["Sales"], summary: "Snapshot fiyatlarla satış detayı", request: { params: saleParams }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await getSale(c.env.DB, data.params.id, c.get("auth").user) });
  }
}
