import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AuthError } from "../auth/errors";
import type { AppContext } from "../types";
import { getSale } from "../sales/repository";
import { saleParams, saleDetailSchema } from "../sales/schemas";
import { pageSchema } from "../finance/schemas";
import { correctionQuery, correctionSchema, createCorrectionSchema, reasonBody } from "./schemas";
import { cancelSale, createCorrection, getCorrection, listCorrections, reviewCorrection } from "./repository";
const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const headers = z.object({ "idempotency-key": z.uuid() });
const invalid = () => new AuthError(400, "INVALID_CORRECTION_INPUT", "Hedef kaydı, düzeltme türünü, gerekçeyi ve istenen değişikliği kontrol edin.");
const single = { description: "Düzeltme talebi ve inceleme geçmişi", ...json(z.object({ data: correctionSchema })) };
export class SaleCancel extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "Ödemesiz satışı gerekçeli iptal et", request: { params: saleParams, headers, body: { required: true, ...json(reasonBody) } },
    responses: { "200": { description: "Geçmişi korunan iptal", ...json(z.object({ data: saleDetailSchema })) } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const actor = c.get("auth").user;
    await cancelSale(c.env.DB, actor, data.params.id, data.headers["idempotency-key"], data.body.reason);
    return c.json({ data: await getSale(c.env.DB, data.params.id, actor) });
  }
}
export class CorrectionCreate extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "İncelenecek düzeltme talebi oluştur", request: { headers, body: { required: true, ...json(createCorrectionSchema) } }, responses: { "201": single, "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    const result = await createCorrection(c.env.DB, c.get("auth").user, data.headers["idempotency-key"], data.body);
    return c.json({ data: result.data }, result.created ? 201 : 200);
  }
}
export class CorrectionList extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "Admin tüm talepleri, çalışan kendi taleplerini görür", request: { query: correctionQuery }, responses: {
    "200": { description: "Talepler", ...json(z.object({ data: z.array(correctionSchema), pagination: pageSchema })) } } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json(await listCorrections(c.env.DB, c.get("auth").user, data.query));
  }
}
export class CorrectionGet extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "Talep detayı", request: { params: saleParams }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await getCorrection(c.env.DB, c.get("auth").user, data.params.id) });
  }
}
export class CorrectionApprove extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "Admin: yalnızca ödemesiz satış iptalini atomik onayla", request: { params: saleParams, headers, body: { required: true, ...json(reasonBody) } }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await reviewCorrection(c.env.DB, c.get("auth").user, data.params.id, data.headers["idempotency-key"], data.body.reason, true) });
  }
}
export class CorrectionReject extends OpenAPIRoute {
  schema = { tags: ["Corrections"], summary: "Admin: talebi gerekçeli reddet", request: { params: saleParams, headers, body: { required: true, ...json(reasonBody) } }, responses: { "200": single } };
  async handle(c: AppContext) {
    const data = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); });
    return c.json({ data: await reviewCorrection(c.env.DB, c.get("auth").user, data.params.id, data.headers["idempotency-key"], data.body.reason, false) });
  }
}
