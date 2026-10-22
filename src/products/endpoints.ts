import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError } from "../auth/errors";
import { createProductSchema, patchProductSchema, productParams, productQuery, productSchema } from "./schemas";
import { createProduct, getProduct, listProducts, patchProduct } from "./repository";

const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const single = { description: "Ürün", ...json(z.object({ data: productSchema })) };
const invalid = () => new AuthError(400, "INVALID_PRODUCT_INPUT", "Ürün adını, kuruş cinsinden fiyatı ve filtreleri kontrol edin.");

export class ProductList extends OpenAPIRoute {
  schema = { tags: ["Products"], summary: "Ürün listesi, arama ve sayfalama", request: { query: productQuery },
    responses: { "200": { description: "Ürün listesi", ...json(z.object({ data: z.array(productSchema),
      pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }) })) } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json(await listProducts(c.env.DB, data.query));
  }
}
export class ProductGet extends OpenAPIRoute {
  schema = { tags: ["Products"], summary: "Ürün detayı", request: { params: productParams }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await getProduct(c.env.DB, data.params.id) });
  }
}
export class ProductCreate extends OpenAPIRoute {
  schema = { tags: ["Products"], summary: "Ürün oluştur (admin)", request: {
    headers: z.object({ "idempotency-key": z.uuid() }), body: { required: true, ...json(createProductSchema) },
  }, responses: { "201": single, "200": { ...single, description: "Aynı oluşturma işleminin tekrar yanıtı" } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const result = await createProduct(c.env.DB, c.get("auth").user.id, data.headers["idempotency-key"], data.body);
    return c.json({ data: result.product }, result.created ? 201 : 200);
  }
}
export class ProductPatch extends OpenAPIRoute {
  schema = { tags: ["Products"], summary: "Ürün düzenle, fiyat ve aktiflik değiştir (admin)", request: {
    params: productParams, body: { required: true, ...json(patchProductSchema) },
  }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await patchProduct(c.env.DB, c.get("auth").user.id, data.params.id, data.body) });
  }
}
