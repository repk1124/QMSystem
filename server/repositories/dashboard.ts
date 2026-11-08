/**
 * 首頁的彙總查詢。
 *
 * 設計原則：首頁不是「數字牆」，而是「今天該做什麼」。
 * 所以待辦清單放第一位，而且每一項都連得到具體的單據，
 * 不是只給一個數字讓人自己去找。
 *
 * 全部在 SQL 裡算完，不要把資料撈回前端再統計 —— 舊系統就是那樣，
 * 資料一多就卡。
 */

import { pool } from "../db";

export interface DashboardData {
  todos: TodoItem[];
  openDeals: { count: number; amount: string; oldest: { number: string; date: string; days: number } | null };
  performance: {
    period: string;
    quoted: { count: number; amount: string };
    won: { count: number; amount: string };
    lost: { count: number };
    winRate: number | null;
    avgDaysToClose: number | null;
  };
  hrAlerts: HrAlert[];
}

export interface TodoItem {
  kind: "suspect_document" | "expiring_quote" | "ready_to_invoice" | "awaiting_payment" | "stale_deal";
  severity: "high" | "medium" | "low";
  label: string;
  detail: string;
  quotationId: number | null;
  quotationNumber: string | null;
  amount: string | null;
}

export interface HrAlert {
  kind: "contract_expiring" | "no_user_account";
  severity: "high" | "medium";
  label: string;
  detail: string;
  employeeId: number | null;
}

/** 進行中但太久沒動靜的天數門檻 */
const STALE_DAYS = 90;
/** 報價快到期的提前提醒天數 */
const EXPIRING_SOON_DAYS = 7;
/** 兼職合約到期的提前提醒天數 */
const CONTRACT_WARN_DAYS = 60;

export async function getDashboard(canSeeAmounts = true): Promise<DashboardData> {
  const [todos, openDeals, performance, hrAlerts] = await Promise.all([
    buildTodos(),
    buildOpenDeals(),
    buildPerformance(),
    buildHrAlerts(),
  ]);

  if (!canSeeAmounts) {
    // 沒有金額檢視權限的人只看得到件數
    openDeals.amount = "0";
    performance.quoted.amount = "0";
    performance.won.amount = "0";
    for (const todo of todos) todo.amount = null;
  }

  return { todos, openDeals, performance, hrAlerts };
}

async function buildTodos(): Promise<TodoItem[]> {
  const todos: TodoItem[] = [];

  // 1. 掛錯的簽回檔 —— 資料正確性問題，優先度最高
  const suspects = await pool.query(`
    SELECT q.id, q.quotation_number, v.client_name_snapshot AS client,
           count(*)::int AS n
    FROM document_links l
    JOIN quotations q ON q.id = l.entity_id AND l.entity_type='quotation'
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE l.verification_status = 'suspect'
    GROUP BY q.id, q.quotation_number, v.client_name_snapshot
    ORDER BY q.quotation_number`);

  for (const row of suspects.rows) {
    todos.push({
      kind: "suspect_document", severity: "high",
      label: "簽回檔可能掛錯",
      detail: `${row.client} — 這份檔案同時掛在其他報價上`,
      quotationId: row.id, quotationNumber: row.quotation_number, amount: null,
    });
  }

  // 2. 已驗收但還沒請款 —— 直接影響現金流
  const readyToInvoice = await pool.query(`
    SELECT q.id, q.quotation_number, q.inspected_at,
           v.client_name_snapshot AS client, v.total_amount,
           (CURRENT_DATE - q.inspected_at) AS days
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE q.fulfillment_status = 'inspected'
    ORDER BY q.inspected_at NULLS LAST`);

  for (const row of readyToInvoice.rows) {
    todos.push({
      kind: "ready_to_invoice", severity: "high",
      label: "已驗收，可以請款",
      detail: row.days != null
        ? `${row.client} — 驗收後已 ${row.days} 天`
        : `${row.client}`,
      quotationId: row.id, quotationNumber: row.quotation_number,
      amount: row.total_amount,
    });
  }

  // 3. 已請款待收款。政府採購法 §73-1：驗收後 30 日內付款，
  //    所以超過 30 天要特別標出來。
  const awaiting = await pool.query(`
    SELECT q.id, q.quotation_number, q.invoiced_at,
           v.client_name_snapshot AS client, v.total_amount,
           (CURRENT_DATE - q.invoiced_at) AS days
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE q.fulfillment_status = 'invoiced'
    ORDER BY q.invoiced_at NULLS LAST`);

  for (const row of awaiting.rows) {
    const overdue = row.days != null && row.days > 30;
    todos.push({
      kind: "awaiting_payment", severity: overdue ? "high" : "medium",
      label: overdue ? "請款逾期未收" : "已請款，待收款",
      detail: row.days != null
        ? `${row.client} — 送件後已 ${row.days} 天${overdue ? "（政府採購法規定 30 日內付款）" : ""}`
        : `${row.client}`,
      quotationId: row.id, quotationNumber: row.quotation_number,
      amount: row.total_amount,
    });
  }

  // 4. 快到期或已過期的報價
  const expiring = await pool.query(`
    SELECT q.id, q.quotation_number, v.valid_until,
           v.client_name_snapshot AS client, v.total_amount,
           (v.valid_until - CURRENT_DATE) AS days_left
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE v.status IN ('sent','viewed')
      AND v.valid_until IS NOT NULL
      AND v.valid_until <= CURRENT_DATE + $1::int
    ORDER BY v.valid_until`, [EXPIRING_SOON_DAYS]);

  for (const row of expiring.rows) {
    const expired = row.days_left < 0;
    todos.push({
      kind: "expiring_quote", severity: expired ? "high" : "medium",
      label: expired ? "報價已過期" : "報價即將到期",
      detail: expired
        ? `${row.client} — 已過期 ${Math.abs(row.days_left)} 天`
        : `${row.client} — 還剩 ${row.days_left} 天`,
      quotationId: row.id, quotationNumber: row.quotation_number,
      amount: row.total_amount,
    });
  }

  // 5. 進行中但很久沒動的案子
  const stale = await pool.query(`
    SELECT q.id, q.quotation_number, v.client_name_snapshot AS client,
           v.total_amount, (CURRENT_DATE - v.quotation_date) AS days
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE q.fulfillment_status = 'in_progress'
      AND v.quotation_date < CURRENT_DATE - $1::int
    ORDER BY v.quotation_date`, [STALE_DAYS]);

  for (const row of stale.rows) {
    todos.push({
      kind: "stale_deal", severity: "medium",
      label: "案子太久沒動靜",
      detail: `${row.client} — 報價至今 ${row.days} 天仍在執行中`,
      quotationId: row.id, quotationNumber: row.quotation_number,
      amount: row.total_amount,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return todos.sort((a, b) => order[a.severity] - order[b.severity]);
}

async function buildOpenDeals() {
  const res = await pool.query(`
    SELECT count(*)::int AS count, COALESCE(sum(v.total_amount),0)::text AS amount
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE q.fulfillment_status IN ('in_progress','delivered','inspected','invoiced','on_hold')`);

  const oldest = await pool.query(`
    SELECT q.quotation_number, v.quotation_date,
           (CURRENT_DATE - v.quotation_date) AS days
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    WHERE q.fulfillment_status IN ('in_progress','delivered','inspected','invoiced','on_hold')
    ORDER BY v.quotation_date LIMIT 1`);

  return {
    count: res.rows[0].count,
    amount: res.rows[0].amount,
    oldest: oldest.rowCount
      ? {
          number: oldest.rows[0].quotation_number,
          date: oldest.rows[0].quotation_date,
          days: oldest.rows[0].days,
        }
      : null,
  };
}

async function buildPerformance() {
  // 本季
  const res = await pool.query(`
    WITH scoped AS (
      SELECT v.status, v.total_amount, v.quotation_date,
             (SELECT min(h.changed_at)::date FROM quotation_status_history h
               WHERE h.version_id = v.id AND h.to_status = 'accepted') AS accepted_on
      FROM quotations q
      JOIN quotation_versions v ON v.id = q.current_version_id
      WHERE v.quotation_date >= date_trunc('quarter', CURRENT_DATE)::date
    )
    SELECT
      count(*)::int AS quoted_count,
      COALESCE(sum(total_amount),0)::text AS quoted_amount,
      count(*) FILTER (WHERE status='accepted')::int AS won_count,
      COALESCE(sum(total_amount) FILTER (WHERE status='accepted'),0)::text AS won_amount,
      count(*) FILTER (WHERE status IN ('declined','expired'))::int AS lost_count,
      avg(accepted_on - quotation_date) FILTER (WHERE accepted_on IS NOT NULL) AS avg_days
    FROM scoped`);

  const row = res.rows[0];
  const won = row.won_count;
  const lost = row.lost_count;
  // 成交率的分母只算已結案的（贏 + 輸），不含還在跑的 ——
  // 否則案子愈多成交率看起來愈低，數字沒有意義
  const decided = won + lost;

  return {
    period: "本季",
    quoted: { count: row.quoted_count, amount: row.quoted_amount },
    won: { count: won, amount: row.won_amount },
    lost: { count: lost },
    winRate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : null,
    avgDaysToClose: row.avg_days == null ? null : Math.round(Number(row.avg_days)),
  };
}

async function buildHrAlerts(): Promise<HrAlert[]> {
  const alerts: HrAlert[] = [];

  const expiring = await pool.query(`
    SELECT id, name, employee_id, contract_end_date,
           (contract_end_date - CURRENT_DATE) AS days_left
    FROM employees
    WHERE contract_end_date IS NOT NULL
      AND termination_date IS NULL
      AND contract_end_date <= CURRENT_DATE + $1::int
    ORDER BY contract_end_date`, [CONTRACT_WARN_DAYS]);

  for (const row of expiring.rows) {
    const expired = row.days_left < 0;
    alerts.push({
      kind: "contract_expiring",
      severity: expired || row.days_left <= 14 ? "high" : "medium",
      label: expired ? "合約已到期" : "合約即將到期",
      detail: `${row.name}（${row.employee_id}）— ${row.contract_end_date}，` +
        (expired ? `已過期 ${Math.abs(row.days_left)} 天` : `還剩 ${row.days_left} 天`),
      employeeId: row.id,
    });
  }

  // 沒有系統帳號的員工 —— 這些人無法登入
  const noAccount = await pool.query(`
    SELECT id, name, employee_id FROM employees
    WHERE user_id IS NULL AND termination_date IS NULL`);

  for (const row of noAccount.rows) {
    alerts.push({
      kind: "no_user_account", severity: "medium",
      label: "員工沒有系統帳號",
      detail: `${row.name}（${row.employee_id}）目前無法登入系統`,
      employeeId: row.id,
    });
  }

  return alerts;
}
