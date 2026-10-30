import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AuthError, forbidden } from "../auth/errors";
import type { AppContext } from "../types";
import { productParams } from "./schemas";
import { getProduct } from "./repository";
import { pageInfo } from "../finance/payments";

const query = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(10) });
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export class ProductPriceHistory extends OpenAPIRoute {
  schema = { tags: ["Products"], summary: "Admin: doğrulanabilir ürün fiyatı değişiklikleri", request: { params: productParams, query }, responses: {
    "200": { description: "Yeniden eskiye fiyat geçmişi", content: { "application/json": { schema: z.object({
      data: z.array(z.object({ id: z.string(), old_price_kurus: money, new_price_kurus: money, actor_user_id: z.string(), username: z.string().nullable(), created_at: z.string() })),
      pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number(), totalPages: z.number() }),
    }) } } },
  } };
  async handle(c: AppContext) {
    if (c.get("auth").user.role !== "admin") throw forbidden();
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw new AuthError(400, "INVALID_PRODUCT_INPUT", "Ürün ve sayfalamayı kontrol edin."); });
    await getProduct(c.env.DB, data.params.id);
    const session = c.env.DB.withSession("first-primary");
    const where = `a.entity_type='product' AND a.entity_id=? AND a.action='product.updated'
      AND json_type(a.metadata,'$.old_price_kurus')='integer' AND json_type(a.metadata,'$.new_price_kurus')='integer'
      AND json_extract(a.metadata,'$.old_price_kurus')<>json_extract(a.metadata,'$.new_price_kurus')`;
    const rows = await session.batch<Record<string, unknown>>([
      session.prepare(`SELECT count(*) AS total FROM audit_logs a WHERE ${where}`).bind(data.params.id),
      session.prepare(`SELECT a.id,a.actor_user_id,u.username,a.created_at,
        json_extract(a.metadata,'$.old_price_kurus') AS old_price_kurus,json_extract(a.metadata,'$.new_price_kurus') AS new_price_kurus
        FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ${where}
        ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`)
        .bind(data.params.id, data.query.pageSize, (data.query.page - 1) * data.query.pageSize),
    ]);
    return c.json({ data: rows[1]!.results, pagination: pageInfo(data.query, Number(rows[0]!.results[0]!.total)) });
  }
}
