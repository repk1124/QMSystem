/**
 * 使用者、角色、產品品項的管理。
 */
import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { hashPassword, assertStrongPassword, linkEmployeesToUsers } from "../auth";
import type { Actor } from "./quotations";

/* ── 使用者 ── */

export async function listUsers() {
  const res = await pool.query(
    `SELECT u.id, u.username, u.email, u.display_name AS "displayName",
            u.role, u.is_active AS "isActive",
            u.must_change_password AS "mustChangePassword",
            u.last_login_at AS "lastLoginAt",
            e.name AS "employeeName", e.employee_id AS "employeeCode"
     FROM users u
     LEFT JOIN employees e ON e.user_id = u.id
     ORDER BY u.is_active DESC, u.username`);
  return res.rows;
}

export async function listRoles() {
  const res = await pool.query(
    `SELECT name, description, permissions, is_system AS "isSystem",
            (SELECT count(*) FROM users u WHERE u.role = r.name)::int AS "userCount"
     FROM roles r ORDER BY r.name`);
  return res.rows;
}

export async function createUser(
  input: { username: string; email: string; displayName?: string; role: string; password: string },
  actor: Actor,
) {
  if (!input.username?.trim()) throw new ValidationError("帳號為必填");
  if (!input.email?.trim()) throw new ValidationError("Email 為必填");
  // 只有帳密一種登入方式，所以初始密碼是必填；首次登入會強制改掉
  assertStrongPassword(input.password);

  const role = await pool.query("SELECT 1 FROM roles WHERE name=$1", [input.role]);
  if (!role.rowCount) throw new ValidationError(`未知的角色：${input.role}`);

  const dup = await pool.query(
    "SELECT username, email FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($2)",
    [input.username, input.email]);
  if (dup.rowCount) {
    throw new ConflictError(
      dup.rows[0].email.toLowerCase() === input.email.toLowerCase()
        ? `Email ${input.email} 已經被帳號 ${dup.rows[0].username} 使用`
        : `帳號 ${input.username} 已存在`);
  }

  return transaction(async client => {
    const res = await client.query(
      `INSERT INTO users (username, password, email, display_name, role, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, username, email, role`,
      [
        input.username.trim(),
        await hashPassword(input.password),
        input.email.trim(), input.displayName ?? null, input.role,
        true,
      ]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'user',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id,
       JSON.stringify({ username: input.username, role: input.role })]);
    // 員工資料已經先建好的話，順手把帳號對上
    await linkEmployeesToUsers(client as never, { userId: res.rows[0].id });
    return res.rows[0];
  });
}

export async function updateUser(
  userId: number,
  patch: { role?: string; isActive?: boolean; displayName?: string },
  actor: Actor,
) {
  return transaction(async client => {
    const res = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (!res.rowCount) throw new NotFoundError("使用者");
    const before = res.rows[0];

    // 不能把最後一個管理員降級或停用，否則沒人管得動系統
    const losingAdmin = (patch.role && patch.role !== "admin" && before.role === "admin")
      || (patch.isActive === false && before.role === "admin");
    if (losingAdmin) {
      const others = await client.query(
        "SELECT count(*)::int AS n FROM users WHERE role='admin' AND is_active=true AND id<>$1",
        [userId]);
      if (others.rows[0].n === 0) {
        throw new ConflictError("這是最後一個啟用中的管理員，不能降級或停用");
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => { params.push(value); sets.push(`${col}=$${params.length}`); };
    if (patch.role !== undefined) set("role", patch.role);
    if (patch.isActive !== undefined) set("is_active", patch.isActive);
    if (patch.displayName !== undefined) set("display_name", patch.displayName);
    if (!sets.length) return { userId, unchanged: true };
    set("updated_at", new Date());

    params.push(userId);
    await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id=$${params.length}`, params);

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'user',$3,'update',$4)`,
      [actor.userId, actor.label, userId, JSON.stringify({
        before: { role: before.role, isActive: before.is_active }, after: patch })]);

    return { userId, ...patch };
  });
}

/* ── 產品品項 ── */

export async function listProducts(search?: string) {
  const params: unknown[] = [];
  let where = "WHERE is_active = true";
  if (search) { params.push(`%${search}%`); where += ` AND (name ILIKE $1 OR sku ILIKE $1)`; }
  const res = await pool.query(
    `SELECT id, sku, name, specification, unit,
            cost_price AS "costPrice", list_price AS "listPrice",
            product_type AS "productType",
            (SELECT count(*) FROM quotation_items i WHERE i.product_id = p.id)::int AS "usageCount"
     FROM products p ${where} ORDER BY "usageCount" DESC, name`, params);
  return res.rows;
}

export async function upsertProduct(
  input: { id?: number; sku?: string; name: string; specification?: string; unit?: string;
           costPrice?: number | null; listPrice?: number | null; productType?: string },
  actor: Actor,
) {
  if (!input.name?.trim()) throw new ValidationError("品項名稱為必填");

  return transaction(async client => {
    if (input.id) {
      const res = await client.query(
        `UPDATE products SET name=$1, specification=$2, unit=$3,
           cost_price=$4, list_price=$5, product_type=$6, updated_at=now()
         WHERE id=$7 RETURNING *`,
        [input.name.trim(), input.specification ?? null, input.unit ?? null,
         input.costPrice ?? null, input.listPrice ?? null,
         input.productType ?? "sale", input.id]);
      if (!res.rowCount) throw new NotFoundError("品項");
      await client.query(
        `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
         VALUES ($1,$2,'product',$3,'update',$4)`,
        [actor.userId, actor.label, input.id, JSON.stringify(input)]);
      return res.rows[0];
    }

    let sku = input.sku?.trim();
    if (!sku) {
      const last = await client.query(
        `SELECT sku FROM products WHERE sku ~ '^P[0-9]+$' ORDER BY sku DESC LIMIT 1`);
      const next = last.rowCount ? parseInt(last.rows[0].sku.slice(1), 10) + 1 : 1;
      sku = `P${String(next).padStart(4, "0")}`;
    }

    const res = await client.query(
      `INSERT INTO products (sku, name, specification, unit, cost_price, list_price, product_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [sku, input.name.trim(), input.specification ?? null, input.unit ?? null,
       input.costPrice ?? null, input.listPrice ?? null, input.productType ?? "sale"]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'product',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id, JSON.stringify({ sku, name: input.name })]);
    return res.rows[0];
  });
}
