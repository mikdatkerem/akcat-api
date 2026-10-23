import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { AuthError } from "../auth/errors";
import { createUserSchema, patchUserSchema, resetPasswordSchema, userSchema, userPageSchema, userQuery, userParams, mutationHeaders } from "./schemas";
import { createUser, patchUser, resetPassword, getUser, listUsers } from "./repository";
const json = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } } });
const single = { description: "Hesap bilgileri; gizli alan içermez", ...json(z.object({ data: userSchema })) };
const invalid = () => new AuthError(400, "INVALID_USER_INPUT", "Kullanıcı adı, rol, hesap durumu ve parolayı (15–128 karakter) kontrol edin.");
export class UserList extends OpenAPIRoute {
  schema = { tags: ["Users"], summary: "Çalışan hesapları (admin)", request: { query: userQuery }, responses: { "200": { description: "Sayfalı hesap listesi", ...json(userPageSchema) } } };
  async handle(c: AppContext) { const { query } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json(await listUsers(c.env.DB, query)); }
}
export class UserGet extends OpenAPIRoute {
  schema = { tags: ["Users"], summary: "Hesap detayı (admin)", request: { params: userParams }, responses: { "200": single } };
  async handle(c: AppContext) { const { params } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json({ data: await getUser(c.env.DB, params.id) }); }
}
export class UserCreate extends OpenAPIRoute {
  schema = { tags: ["Users"], summary: "Hesap oluştur (admin)", request: { headers: mutationHeaders, body: { required: true, ...json(createUserSchema) } }, responses: { "201": single, "200": single } };
  async handle(c: AppContext) { const { body, headers } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); const result = await createUser(c.env.DB, c.get("auth"), headers["idempotency-key"], body); return c.json({ data: result.user }, result.created ? 201 : 200); }
}
export class UserPatch extends OpenAPIRoute {
  schema = { tags: ["Users"], summary: "Hesap düzenle (admin)", request: { params: userParams, headers: mutationHeaders, body: { required: true, ...json(patchUserSchema) } }, responses: { "200": single } };
  async handle(c: AppContext) { const { body, params, headers } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json({ data: await patchUser(c.env.DB, c.get("auth"), params.id, headers["idempotency-key"], body) }); }
}
export class UserResetPassword extends OpenAPIRoute {
  schema = { tags: ["Users"], summary: "Parolayı sıfırla ve tüm oturumları iptal et (admin)", request: { params: userParams, headers: mutationHeaders, body: { required: true, ...json(resetPasswordSchema) } }, responses: { "200": single } };
  async handle(c: AppContext) { const { body, params, headers } = await this.getValidatedData<typeof this.schema>().catch(() => { throw invalid(); }); return c.json({ data: await resetPassword(c.env.DB, c.get("auth"), params.id, headers["idempotency-key"], body.password) }); }
}
