#!/usr/bin/env node
/**
 * 重設使用者密碼，或直接列出目前有哪些帳號。
 *
 * 為什麼需要這支：管理員自己忘記密碼時沒有人能幫他重設；
 * 而且資料庫裡已經有使用者時，啟動不會再用 INITIAL_ADMIN_PASSWORD 建帳號。
 *
 * 用法（非 Docker）：
 *   node scripts/reset-password.mjs                        # 列出所有帳號
 *   node scripts/reset-password.mjs admin <新密碼>          # 重設某人的密碼
 *   node scripts/reset-password.mjs admin <新密碼> --admin  # 順便升為管理員
 * Docker：
 *   docker compose exec app node scripts/reset-password.mjs admin <新密碼>
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 未設定'); process.exit(1); }

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const makeAdmin = process.argv.includes('--admin');
const [username, password] = args;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (!username) {
    const res = await client.query(
      `SELECT id, username, email, role, is_active, must_change_password, last_login_at
       FROM users ORDER BY id`);

    if (!res.rowCount) {
      console.log('\n資料庫裡沒有任何使用者。');
      console.log('啟動應用程式就會自動建立初始管理員（見 .env.example 的 INITIAL_ADMIN_*）。\n');
    } else {
      console.log('\n目前的帳號：\n');
      console.table(res.rows.map(r => ({
        帳號: r.username,
        Email: r.email,
        角色: r.role,
        啟用: r.is_active ? '是' : '否',
        須改密碼: r.must_change_password ? '是' : '否',
        最後登入: r.last_login_at ? new Date(r.last_login_at).toLocaleString('zh-TW') : '從未',
      })));
      console.log('要重設密碼：node scripts/reset-password.mjs <帳號> <新密碼>\n');
    }
    process.exit(0);
  }

  if (!password) {
    console.error('請一併指定新密碼：node scripts/reset-password.mjs <帳號> <新密碼>');
    process.exit(1);
  }
  // 跟系統其他地方同一套規則，不要在這裡開後門
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    console.error('密碼至少 10 個字元，且要同時包含英文字母與數字。');
    process.exit(1);
  }

  const found = await client.query(
    'SELECT id, username, email, role FROM users WHERE lower(username)=lower($1)', [username]);
  if (!found.rowCount) {
    console.error(`\n找不到帳號「${username}」。先執行不帶參數的版本看看有哪些帳號。\n`);
    process.exit(1);
  }
  const user = found.rows[0];

  await client.query(
    `UPDATE users
     SET password=$1, must_change_password=true, is_active=true,
         role = CASE WHEN $2::boolean THEN 'admin' ELSE role END,
         updated_at=now()
     WHERE id=$3`,
    [await bcrypt.hash(password, 12), makeAdmin, user.id]);

  await client.query(
    `INSERT INTO audit_log (actor_label, entity_type, entity_id, action, changes)
     VALUES ('命令列工具','user',$1,'update',$2)`,
    [user.id, JSON.stringify({ passwordReset: true, madeAdmin: makeAdmin })]);

  console.log(`\n✓ 已重設「${user.username}」（${user.email}）的密碼`);
  if (makeAdmin && user.role !== 'admin') console.log('✓ 已升為管理員');
  console.log('  下次登入會要求再改一次密碼。\n');
} finally {
  await client.end();
}
