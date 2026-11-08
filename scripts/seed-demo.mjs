#!/usr/bin/env node
/**
 * 示範／測試用帳號與資料（可重複執行，不會重複建）。
 *
 *   使用者：demo-employee / DemoEmployee123（一般員工，已對應員工資料，不用改密碼）
 *           demo-manager  / DemoManager123 （主管）
 *   員工：  D001 王小明（研發部 工程師，到職 2024-03-01）
 *   客戶：  範例客戶股份有限公司（統編 10000004）＋聯絡人
 *   品項：  示範主機、示範安裝服務
 *
 * 用法：
 *   非 Docker：DATABASE_URL=... node scripts/seed-demo.mjs
 *   Docker：   docker compose exec app node scripts/seed-demo.mjs
 * 正式環境用完請到「使用者與權限」停用這些帳號。
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 未設定'); process.exit(1); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const USERS = [
  { username: 'demo-employee', password: 'DemoEmployee123', email: 'demo-employee@example.com', name: '王小明', role: 'employee' },
  { username: 'demo-manager', password: 'DemoManager123', email: 'demo-manager@example.com', name: '李小華', role: 'manager' },
];

try {
  for (const u of USERS) {
    const res = await client.query(
      `INSERT INTO users (username, password, email, display_name, role, must_change_password)
       VALUES ($1,$2,$3,$4,$5,false)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [u.username, await bcrypt.hash(u.password, 12), u.email, u.name, u.role]);
    console.log(res.rowCount ? `已建立使用者 ${u.username}` : `使用者 ${u.username} 已存在`);
  }

  const dept = await client.query(
    `INSERT INTO departments (name) VALUES ('研發部') ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const pos = await client.query(
    `INSERT INTO positions (title, department_id) VALUES ('工程師', $1)
     ON CONFLICT (title) DO UPDATE SET title=EXCLUDED.title RETURNING id`, [dept.rows[0].id]);
  const emp = await client.query(
    `INSERT INTO employees (employee_id, name, email, hire_date, department_id, position_id, salary_amount, salary_type)
     VALUES ('D001','王小明','demo-employee@example.com','2024-03-01',$1,$2,45000,'monthly')
     ON CONFLICT (employee_id) DO NOTHING RETURNING id`, [dept.rows[0].id, pos.rows[0].id]);
  console.log(emp.rowCount ? '已建立員工 D001 王小明' : '員工 D001 已存在');
  // 把員工對到帳號（email 相同）
  await client.query(
    `UPDATE employees e SET user_id = u.id FROM users u
      WHERE e.user_id IS NULL AND lower(u.email) = lower(e.email)
        AND u.id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL)`);

  const cl = await client.query(
    `INSERT INTO clients (code, name, tax_id, address, phone, category)
     VALUES ('DEMO-0004','範例客戶股份有限公司','10000004','台北市中正區範例路 100 號','02-23456789','company')
     ON CONFLICT (code) DO NOTHING RETURNING id`);
  if (cl.rowCount) {
    await client.query(`INSERT INTO client_name_history (client_id, name, valid_from, note) VALUES ($1,'範例客戶股份有限公司',CURRENT_DATE,'示範資料')`, [cl.rows[0].id]);
    await client.query(`INSERT INTO client_contacts (client_id, name, title, email, phone, is_primary) VALUES ($1,'陳小美','採購','chen@example.com','0912-345678',true)`, [cl.rows[0].id]);
    console.log('已建立客戶 範例客戶股份有限公司');
  } else console.log('客戶 DEMO-0004 已存在');

  for (const [sku, name, spec, unit, cost, price] of [
    ['DEMO-001', '示範主機', '含三年保固', '台', 20000, 32000],
    ['DEMO-002', '示範安裝服務', '到府安裝與教學', '式', 2000, 5000],
  ]) {
    const r = await client.query(
      `INSERT INTO products (sku, name, specification, unit, cost_price, list_price) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sku) DO NOTHING RETURNING id`, [sku, name, spec, unit, cost, price]);
    console.log(r.rowCount ? `已建立品項 ${name}` : `品項 ${sku} 已存在`);
  }

  console.log('\n完成。測試帳號：demo-employee / DemoEmployee123（一般員工）、demo-manager / DemoManager123（主管）');
} finally {
  await client.end();
}
