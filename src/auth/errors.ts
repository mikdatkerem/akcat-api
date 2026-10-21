import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AuthError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = () => new AuthError(401, "UNAUTHORIZED", "Geçerli bir oturum gerekli.");
export const invalidLogin = () => new AuthError(401, "INVALID_CREDENTIALS", "Kullanıcı adı veya parola hatalı.");
export const forbidden = () => new AuthError(403, "FORBIDDEN", "Bu işlem için yetkiniz yok.");
export const unavailable = () => new AuthError(503, "AUTH_UNAVAILABLE", "Kimlik doğrulama şu anda kullanılamıyor.");
