import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError, forbidden } from "../auth/errors";
import { createCustomerSchema, patchCustomerSchema, customerParams, customerQuery, customerSchema } from "./schemas";
import { createCustomer, getCustomer, listCustomers, patchCustomer } from "./repository";

const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const single = { description: "Müşteri", ...json(z.object({ data: customerSchema })) };
const invalid = () => new AuthError(400, "INVALID_CUSTOMER_INPUT", "Müşteri alanlarını, telefonu ve sayfalama değerlerini kontrol edin.");

export class CustomerList extends OpenAPIRoute {
  schema = { tags: ["Customers"], summary: "Müşteri listesi, arama ve sayfalama", request: { query: customerQuery },
    responses: { "200": { description: "Müşteri listesi", ...json(z.object({ data: z.array(customerSchema),
      pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }) })) } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json(await listCustomers(c.env.DB, data.query));
  }
}
export class CustomerGet extends OpenAPIRoute {
  schema = { tags: ["Customers"], summary: "Müşteri detayı", request: { params: customerParams }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await getCustomer(c.env.DB, data.params.id) });
  }
}
export class CustomerCreate extends OpenAPIRoute {
  schema = { tags: ["Customers"], summary: "Müşteri oluştur", request: {
    headers: z.object({ "idempotency-key": z.uuid() }), body: { required: true, ...json(createCustomerSchema) },
  }, responses: { "201": single, "200": { ...single, description: "Aynı oluşturma işleminin tekrar yanıtı" } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const result = await createCustomer(c.env.DB, c.get("auth").user.id, data.headers["idempotency-key"], data.body);
    return c.json({ data: result.customer }, result.created ? 201 : 200);
  }
}
export class CustomerPatch extends OpenAPIRoute {
  schema = { tags: ["Customers"], summary: "Müşteri düzenle; aktiflik yalnızca admin", request: {
    params: customerParams, body: { required: true, ...json(patchCustomerSchema) },
  }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    if (data.body.is_active !== undefined && c.get("auth").user.role !== "admin") throw forbidden();
    return c.json({ data: await patchCustomer(c.env.DB, c.get("auth").user.id, data.params.id, data.body) });
  }
}
