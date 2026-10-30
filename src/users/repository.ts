import { authorizedBatch } from "../security/authorizedBatch";
import { AuthError, forbidden } from "../auth/errors";
import type { AuthSession, Role } from "../types";
import { hashPassword, verifyPassword } from "../security/password";
import { tokenHash } from "../security/tokens";
import { pageInfo } from "../finance/payments";
import { turkishName } from "../finance/receivables";
import type { CreateUserInput, PatchUserInput, UserQuery } from "./schemas";

type Row = { id: string; username: string; role: Role; is_active: number; created_at: string; updated_at: string; password_hash?: string };
const columns = "id, username, role, is_active, created_at, updated_at";
// Explicit projection: even internal idempotency reads can never leak a password hash.
const present = (row: Row) => ({ id: row.id, username: row.username, role: row.role, is_active: row.is_active === 1, created_at: row.created_at, updated_at: row.updated_at });
const missing = () => new AuthError(404, "USER_NOT_FOUND", "Kullanıcı bulunamadı.");
const conflict = () => new AuthError(409, "IDEMPOTENCY_CONFLICT", "İşlem anahtarı farklı bilgilerle kullanılmış veya parola daha sonra değiştirilmiş. Kullanıcıyı yeniden yükleyin.");
// Recheck within the write transaction, including after a potentially slow KDF.
const actorGate = `EXISTS(SELECT 1 FROM users actor JOIN sessions ses ON ses.user_id=actor.id
  WHERE actor.id=? AND actor.role='admin' AND actor.is_active=1 AND ses.id=? AND ses.revoked_at IS NULL AND ses.expires_at>?)`;
const attemptGate = `EXISTS(SELECT 1 FROM audit_logs WHERE id=? AND json_extract(metadata,'$.attempt')=?)`;
const allowedStatement = (db: D1DatabaseSession, auth: AuthSession, now: string) => db.prepare(`SELECT ${actorGate} AS allowed`).bind(auth.user.id, auth.id, now);
const assertActor = (result: D1Result<Record<string, unknown>>) => { if (result.results[0]?.allowed !== 1) throw forbidden(); };

export async function getUser(db: D1Database, id: string) {
  const row = await db.withSession("first-primary").prepare(`SELECT ${columns} FROM users WHERE id=?`).bind(id).first<Row>();
  if (!row) throw missing();
  return present(row);
}
export async function listUsers(db: D1Database, query: UserQuery) {
  const terms: string[] = [], params: (string | number)[] = [];
  if (query.q) { terms.push(`instr(${turkishName("username")},?)>0`); params.push(query.q.toLocaleLowerCase("tr-TR")); }
  if (query.status !== "all") { terms.push("is_active=?"); params.push(query.status === "active" ? 1 : 0); }
  const where = terms.length ? `WHERE ${terms.join(" AND ")}` : "", session = db.withSession("first-primary");
  const rows = await session.batch<Record<string, unknown>>([session.prepare(`SELECT count(*) AS total FROM users ${where}`).bind(...params),
    session.prepare(`SELECT ${columns} FROM users ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).bind(...params, query.pageSize, (query.page - 1) * query.pageSize)]);
  return { data: (rows[1]!.results as Row[]).map(present), pagination: pageInfo(query, Number(rows[0]!.results[0]!.total)) };
}
export async function createUser(db: D1Database, auth: AuthSession, key: string, input: CreateUserInput) {
  const hash = await hashPassword(input.password), id = crypto.randomUUID(), attempt = crypto.randomUUID(), now = new Date().toISOString();
  const operation = `user:create:${tokenHash(auth.user.id + ":" + key)}`, session = db.withSession("first-primary");
  // No fast digest of a password: it would permit offline guessing without scrypt.
  const metadata = JSON.stringify({ username: input.username, role: input.role, attempt });
  const rows = await authorizedBatch<Record<string, unknown>>(session, auth, [
    allowedStatement(session, auth, now),
    session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      SELECT ?,?,'user.created','user',?,?,? WHERE ${actorGate}
      AND NOT EXISTS(SELECT 1 FROM users WHERE username=?) AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
      .bind(operation, auth.user.id, id, metadata, now, auth.user.id, auth.id, now, input.username, operation),
    session.prepare(`INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at)
      SELECT ?,?,?,?,1,?,? WHERE ${attemptGate}`).bind(id, input.username, hash, input.role, now, now, operation, attempt),
    session.prepare("SELECT entity_id,metadata FROM audit_logs WHERE id=?").bind(operation),
    session.prepare(`SELECT u.* FROM users u JOIN audit_logs a ON a.entity_id=u.id WHERE a.id=?`).bind(operation),
  ]);
  assertActor(rows[0]!);
  const audit = rows[3]!.results[0];
  if (!audit) throw new AuthError(409, "USERNAME_TAKEN", "Bu kullanıcı adı zaten kullanılıyor.");
  const original = JSON.parse(String(audit.metadata)), row = rows[4]!.results[0] as Row | undefined;
  if (!row) throw new AuthError(409, "USER_DELETED", "Bu işlemle oluşturulan hesap daha sonra silinmiş. Çalışan listesini yenileyin.");
  const created = rows[2]!.meta.changes === 1;
  if (original.username !== input.username || original.role !== input.role || (!created && !await verifyPassword(input.password, row.password_hash))) throw conflict();
  return { user: present(row), created };
}
export async function patchUser(db: D1Database, auth: AuthSession, id: string, key: string, input: PatchUserInput) {
  const now = new Date().toISOString(), attempt = crypto.randomUUID(), session = db.withSession("first-primary");
  const operation = `user:update:${tokenHash(auth.user.id + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([id, input.username ?? null, input.role ?? null, input.is_active ?? null]));
  const rows = await authorizedBatch<Record<string, unknown>>(session, auth, [
    allowedStatement(session, auth, now),
    session.prepare(`WITH candidate AS (SELECT t.*,coalesce(?,t.username) AS next_username,coalesce(?,t.role) AS next_role,
      coalesce(?,t.is_active) AS next_active FROM users t WHERE id=?)
      INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      SELECT ?,?,'user.updated','user',t.id,json_object('request_hash',?,'attempt',?,
        'before',json_object('username',t.username,'role',t.role,'is_active',t.is_active),
        'after',json_object('username',t.next_username,'role',t.next_role,'is_active',t.next_active)),?
      FROM candidate t WHERE ${actorGate}
        AND (t.id<>? OR (t.next_role='admin' AND t.next_active=1))
        AND (t.role<>'admin' OR t.is_active<>1 OR (t.next_role='admin' AND t.next_active=1)
          OR (SELECT count(*) FROM users WHERE role='admin' AND is_active=1)>1)
        AND NOT EXISTS(SELECT 1 FROM users u WHERE u.username=t.next_username AND u.id<>t.id)
        AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
      .bind(input.username ?? null, input.role ?? null, input.is_active === undefined ? null : Number(input.is_active), id,
        operation, auth.user.id, fingerprint, attempt, now, auth.user.id, auth.id, now, auth.user.id, operation),
    session.prepare(`UPDATE users SET username=(SELECT json_extract(metadata,'$.after.username') FROM audit_logs WHERE id=?),
      role=(SELECT json_extract(metadata,'$.after.role') FROM audit_logs WHERE id=?),
      is_active=(SELECT json_extract(metadata,'$.after.is_active') FROM audit_logs WHERE id=?),updated_at=? WHERE id=? AND ${attemptGate}`)
      .bind(operation, operation, operation, now, id, operation, attempt),
    session.prepare(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${attemptGate}
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=0)`).bind(now, id, operation, attempt, id),
    session.prepare("SELECT entity_id,metadata FROM audit_logs WHERE id=?").bind(operation),
    session.prepare(`SELECT ${columns} FROM users WHERE id=?`).bind(id),
    session.prepare("SELECT id FROM users WHERE username=? AND id<>?").bind(input.username ?? "", id),
  ]);
  assertActor(rows[0]!);
  const audit = rows[4]!.results[0], row = rows[5]!.results[0] as Row | undefined;
  if (audit) {
    if (audit.entity_id !== id || JSON.parse(String(audit.metadata)).request_hash !== fingerprint) throw conflict();
  } else {
    if (!row) throw missing();
    if (id === auth.user.id && (input.role === "employee" || input.is_active === false)) throw new AuthError(409, "SELF_ACCOUNT_LOCKOUT", "Kendi hesabınızı pasife alamaz veya admin rolünüzü düşüremezsiniz.");
    if (rows[6]!.results.length) throw new AuthError(409, "USERNAME_TAKEN", "Bu kullanıcı adı zaten kullanılıyor.");
    throw new AuthError(409, "LAST_ACTIVE_ADMIN", "Son aktif admin korunmalıdır. Hesabı yeniden yükleyin.");
  }
  if (!row) throw missing();
  return present(row);
}
export async function resetPassword(db: D1Database, auth: AuthSession, id: string, key: string, password: string) {
  const hash = await hashPassword(password), now = new Date().toISOString(), attempt = crypto.randomUUID(), session = db.withSession("first-primary");
  const operation = `user:reset-password:${tokenHash(auth.user.id + ":" + key)}`;
  const rows = await authorizedBatch<Record<string, unknown>>(session, auth, [
    allowedStatement(session, auth, now),
    session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      SELECT ?,?,'user.password_reset','user',id,?,? FROM users WHERE id=? AND ${actorGate}
      AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
      .bind(operation, auth.user.id, JSON.stringify({ fields: ["password"], attempt }), now, id, auth.user.id, auth.id, now, operation),
    session.prepare(`UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND ${attemptGate}`).bind(hash, now, id, operation, attempt),
    session.prepare(`UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND ${attemptGate}`).bind(now, id, operation, attempt),
    session.prepare("SELECT entity_id FROM audit_logs WHERE id=?").bind(operation),
    session.prepare("SELECT * FROM users WHERE id=?").bind(id),
  ]);
  assertActor(rows[0]!);
  const audit = rows[4]!.results[0], row = rows[5]!.results[0] as Row | undefined;
  if (!audit) throw missing();
  if (!row || audit.entity_id !== id || (rows[2]!.meta.changes !== 1 && !await verifyPassword(password, row.password_hash))) throw conflict();
  return present(row);
}

// Include cancelled sales, reversed payments, rejected requests and all adjustment actors.
const financialHistory = `EXISTS(SELECT 1 FROM sales WHERE created_by=u.id)
  OR EXISTS(SELECT 1 FROM payments WHERE created_by=u.id)
  OR EXISTS(SELECT 1 FROM correction_requests WHERE requested_by=u.id OR reviewed_by=u.id)
  OR EXISTS(SELECT 1 FROM financial_adjustments WHERE requested_by=u.id OR performed_by=u.id OR approved_by=u.id)`;
// Never detach/delete audit actors. Target-only account-management audits are retained.
const auditHistory = `EXISTS(SELECT 1 FROM audit_logs WHERE actor_user_id=u.id)
  OR EXISTS(SELECT 1 FROM audit_logs WHERE entity_type='user' AND entity_id=u.id
    AND action NOT IN ('user.created','user.updated','user.password_reset'))`;
const userInUse = () => new AuthError(409, "USER_IN_USE", "Bu hesap geçmiş denetim veya ilişkili kayıtlarda yer aldığı için kalıcı olarak silinemez. Hesabını pasife alabilirsiniz.");

export async function deleteUser(db: D1Database, auth: AuthSession, id: string, key: string) {
  const operation = `user:delete:${tokenHash(auth.user.id + ":" + key)}`;
  const attempt = crypto.randomUUID(), now = new Date().toISOString(), session = db.withSession("first-primary");
  let rows: D1Result<Record<string, unknown>>[];
  try {
    // One transaction protects the actor, last admin, references, sessions and audit.
    rows = await authorizedBatch(session, auth, [
      allowedStatement(session, auth, now),
      session.prepare(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
        SELECT ?,?,'user.deleted','user',u.id,json_object('attempt',?,'username',u.username,'role',u.role,'is_active',u.is_active),?
        FROM users u WHERE u.id=? AND u.id<>? AND ${actorGate}
          AND (u.role<>'admin' OR u.is_active<>1 OR (SELECT count(*) FROM users WHERE role='admin' AND is_active=1)>1)
          AND NOT (${financialHistory}) AND NOT (${auditHistory})
          AND NOT EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`)
        .bind(operation, auth.user.id, attempt, now, id, auth.user.id, auth.user.id, auth.id, now, operation),
      // Session rows are authentication state, never business history. Removing them invalidates every token.
      session.prepare(`DELETE FROM sessions WHERE user_id=? AND ${attemptGate}`).bind(id, operation, attempt),
      session.prepare(`DELETE FROM users WHERE id=? AND ${attemptGate}`).bind(id, operation, attempt),
      session.prepare("SELECT entity_id FROM audit_logs WHERE id=? AND actor_user_id=?").bind(operation, auth.user.id),
      session.prepare(`SELECT u.id,u.role,u.is_active,(${financialHistory}) AS financial_history,(${auditHistory}) AS audit_history,
        (SELECT count(*) FROM users WHERE role='admin' AND is_active=1) AS active_admins FROM users u WHERE u.id=?`).bind(id),
    ]);
  } catch (cause) {
    let error: unknown = cause;
    for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
      if (/FOREIGN KEY constraint failed/i.test(error.message)) throw userInUse();
    }
    throw cause;
  }
  assertActor(rows[0]!);
  const audit = rows[4]?.results[0], user = rows[5]?.results[0];
  if (audit) {
    if (audit.entity_id !== id) throw conflict();
    return { success: true as const, id };
  }
  if (!user) throw missing();
  if (id === auth.user.id) throw new AuthError(409, "SELF_ACCOUNT_DELETE", "Kendi hesabınızı silemezsiniz.");
  if (user.role === "admin" && user.is_active === 1 && Number(user.active_admins) <= 1) {
    throw new AuthError(409, "LAST_ACTIVE_ADMIN", "Son aktif admin hesabı silinemez.");
  }
  if (user.financial_history === 1) throw new AuthError(409, "USER_FINANCIAL_HISTORY", "Bu çalışan geçmiş finansal işlemlerde yer aldığı için kalıcı olarak silinemez. Hesabını pasife alabilirsiniz.");
  if (user.audit_history === 1) throw userInUse();
  throw new AuthError(409, "USER_DELETE_CONFLICT", "Hesap silinemedi. Çalışan listesini yenileyip tekrar deneyin.");
}
