import { forbidden } from "../auth/errors";
import type { AuthSession } from "../types";

// This assertion is the FIRST statement of the SAME D1 transaction as the writes.
// The deliberately invalid JSON path is evaluated only on denial; its identifiable
// SQL error rolls back the entire batch. No audit row or temporary DB object is needed.
// Requiring the captured role to remain identical also protects role-dependent predicates.
export async function authorizedBatch<T = Record<string, unknown>>(
  session: D1DatabaseSession, auth: AuthSession, statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  const assertion = session.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
    WHERE u.id=? AND u.is_active=1 AND u.role=? AND u.role IN ('admin','employee')
      AND s.id=? AND s.revoked_at IS NULL
      AND julianday(s.expires_at) > julianday('now')
  ) THEN 1 ELSE json_extract('{}', 'AKCAT_WRITE_AUTHORIZATION_DENIED') END AS authorized`)
    .bind(auth.user.id, auth.user.role, auth.id);
  try {
    return (await session.batch<T>([assertion, ...statements])).slice(1);
  } catch (cause) {
    let error: unknown = cause;
    for (let depth = 0; depth < 6 && error instanceof Error; depth++, error = error.cause) {
      if (error.message.includes("AKCAT_WRITE_AUTHORIZATION_DENIED")) throw forbidden();
    }
    throw cause;
  }
}
