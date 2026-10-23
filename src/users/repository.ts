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
  const rows = await session.batch<Record<string, unknown>>([
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
  const original = JSON.parse(String(audit.metadata)), row = rows[4]!.results[0] as Row;
  const created = rows[2]!.meta.changes === 1;
  if (original.username !== input.username || original.role !== input.role || (!created && !await verifyPassword(input.password, row.password_hash))) throw conflict();
  return { user: present(row), created };
}
export async function patchUser(db: D1Database, auth: AuthSession, id: string, key: string, input: PatchUserInput) {
  const now = new Date().toISOString(), attempt = crypto.randomUUID(), session = db.withSession("first-primary");
  const operation = `user:update:${tokenHash(auth.user.id + ":" + key)}`;
  const fingerprint = tokenHash(JSON.stringify([id, input.username ?? null, input.role ?? null, input.is_active ?? null]));
  const rows = await session.batch<Record<string, unknown>>([
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
  const rows = await session.batch<Record<string, unknown>>([
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
