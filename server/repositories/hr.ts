/**
 * 人事資料層。
 *
 * 舊系統缺的三塊，這裡補上：
 *   1. 特休制度 —— 舊系統有「年假」這個假別，但不知道每個人有幾天
 *   2. 出勤修改留痕 —— 舊系統直接覆蓋，勞檢最看這個
 *   3. 薪資與工時的數值化 —— 舊系統 salary 是 text，30000 跟 196 混在一起
 */

import type { PoolClient } from "pg";
import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { linkEmployeesToUsers } from "../auth";
import type { Actor } from "./quotations";

/* ── 特別休假 ─────────────────────────────────────────────
   勞基法 §38：
     6 個月以上未滿 1 年   3 日
     1 年以上未滿 2 年     7 日
     2 年以上未滿 3 年    10 日
     3 年以上未滿 5 年    14 日
     5 年以上未滿 10 年   15 日
     10 年以上            每滿 1 年加 1 日，加至 30 日為止           */

export function annualLeaveDays(yearsOfService: number): number {
  if (yearsOfService < 0.5) return 0;
  if (yearsOfService < 1) return 3;
  if (yearsOfService < 2) return 7;
  if (yearsOfService < 3) return 10;
  if (yearsOfService < 5) return 14;
  if (yearsOfService < 10) return 15;
  return Math.min(30, 15 + (Math.floor(yearsOfService) - 9));
}

/** 到職日起算的第 n 個週年區間 */
export function anniversaryPeriod(hireDate: string, index: number) {
  const [y, m, d] = hireDate.split("-").map(Number);
  const start = new Date(Date.UTC(y + index, m - 1, d));
  const end = new Date(Date.UTC(y + index + 1, m - 1, d));
  end.setUTCDate(end.getUTCDate() - 1);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

/** 兩個日期之間的年資（以年為單位，帶小數） */
export function yearsBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return (b - a) / (365.2425 * 24 * 3600 * 1000);
}

/**
 * 產生／更新某位員工到今天為止的所有特休年度。
 *
 * 採週年制（勞基法的原則），從到職日起算。
 * 未休完的天數會遞延到下一年度（施行細則 §24-1：
 * 經勞雇雙方協商得遞延一年，遞延期滿仍未休須發給工資）。
 */
export async function ensureEntitlements(
  employeeId: number,
  today = new Date().toISOString().slice(0, 10),
  existingClient?: PoolClient,
) {
  // 如果呼叫端已經在一個交易裡（例如核准請假時），就共用它的連線。
  // 否則每次都另外 pool.connect() 會有兩個問題：
  //   1. 那次結算跟外層交易不同步 —— 外層 rollback 時它已經 commit 了
  //   2. 每個請求同時佔用兩條連線，量一大就把連線池吃光
  if (existingClient) return runEnsureEntitlements(existingClient, employeeId, today);
  return transaction(client => runEnsureEntitlements(client, employeeId, today));
}

async function runEnsureEntitlements(
  client: PoolClient,
  employeeId: number,
  today: string,
) {
    const emp = await client.query(
      "SELECT hire_date, termination_date FROM employees WHERE id=$1",
      [employeeId],
    );
    if (!emp.rowCount) throw new NotFoundError("員工");

    const hireDate: string = emp.rows[0].hire_date;
    const endLimit: string = emp.rows[0].termination_date ?? today;

    const periods = [];
    for (let index = 0; index < 60; index += 1) {
      const period = anniversaryPeriod(hireDate, index);
      if (period.start > endLimit) break;
      const years = index; // 該年度開始時的年資
      periods.push({ ...period, index, years });
    }

    let carriedIn = 0;
    const results = [];

    for (const period of periods) {
      // 滿 6 個月當年度另外給 3 天：週年制下第 0 年（未滿 1 年）給 3 日，
      // 但要到滿 6 個月才發生
      const entitled = period.index === 0
        ? (yearsBetween(hireDate, endLimit) >= 0.5 ? 3 : 0)
        : annualLeaveDays(period.index);

      // 已核准的特休天數
      const used = await client.query(
        `SELECT COALESCE(sum(days),0)::float8 AS d
         FROM leave_requests
         WHERE employee_id=$1 AND leave_type='annual' AND status='approved'
           AND start_date >= $2 AND start_date <= $3`,
        [employeeId, period.start, period.end],
      );
      const usedDays = used.rows[0].d;

      const available = entitled + carriedIn;
      const remaining = Math.max(0, available - usedDays);

      // 休假先扣「遞延進來的」再扣「當年度的」——
      // 遞延假只能再放一年，先用掉才不會浪費。
      const usedFromCarried = Math.min(carriedIn, usedDays);
      const usedFromEntitled = Math.max(0, usedDays - carriedIn);
      const unusedCarried = Math.max(0, carriedIn - usedFromCarried);
      const unusedEntitled = Math.max(0, entitled - usedFromEntitled);

      const isClosed = period.end < today;

      // 勞基法施行細則 §24-1：未休完得經協商遞延「一年」，
      // 遞延期滿仍未休者，雇主應發給工資。
      //
      // 所以年度結束時：
      //   當年度自己的未休天數 → 可以遞延到下一年度
      //   已經遞延過一次的天數 → 不能再遞延，必須折發工資
      //
      // 這一段如果寫錯（把全部剩餘都往下滾），假會無限累積，
      // 帳面上看起來很多天，實際上公司少發了應付的工資。
      const carriedOut = isClosed ? unusedEntitled : 0;
      const mustPayOut = isClosed ? unusedCarried : 0;

      const res = await client.query(
        `INSERT INTO leave_entitlements
           (employee_id, period_start, period_end, entitled_days, carried_in_days, used_days, carried_out_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (employee_id, period_start) DO UPDATE SET
           period_end = EXCLUDED.period_end,
           entitled_days = EXCLUDED.entitled_days,
           carried_in_days = EXCLUDED.carried_in_days,
           used_days = EXCLUDED.used_days,
           carried_out_days = EXCLUDED.carried_out_days,
           updated_at = now()
         RETURNING *`,
        [employeeId, period.start, period.end, entitled, carriedIn, usedDays, carriedOut],
      );

      // 應折發工資的天數也要記錄下來，這是雇主的義務不是選項
      if (mustPayOut > 0) {
        await client.query(
          `UPDATE leave_entitlements SET paid_out_days=$1 WHERE id=$2
           AND (paid_out_days IS NULL OR paid_out_days = 0)`,
          [mustPayOut, res.rows[0].id],
        );
      }

      results.push({
        ...res.rows[0],
        available,
        remaining,
        mustPayOut,
        isCurrent: period.start <= today && today <= period.end,
      });
      carriedIn = carriedOut;
    }

    return results;
}

/* ── 員工 ─────────────────────────────────────────────── */

export async function listEmployees(includeInactive = false) {
  const res = await pool.query(
    `SELECT e.id, e.employee_id AS "employeeId", e.name, e.email, e.phone,
            e.hire_date AS "hireDate", e.termination_date AS "terminationDate",
            e.employment_type AS "employmentType",
            e.contract_end_date AS "contractEndDate",
            e.monthly_work_hours AS "monthlyWorkHours",
            e.requires_clock_in AS "requiresClockIn",
            e.partner_name AS "partnerName",
            d.name AS "departmentName", p.title AS "positionTitle",
            u.id AS "userId", u.role AS "userRole",
            (SELECT count(*) FROM leave_requests l
              WHERE l.employee_id=e.id AND l.status='pending')::int AS "pendingLeaves"
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN positions p ON p.id = e.position_id
     LEFT JOIN users u ON u.id = e.user_id
     ${includeInactive ? "" : "WHERE e.termination_date IS NULL"}
     ORDER BY e.employee_id`,
  );
  return res.rows;
}

/** 薪資是敏感欄位，另外一支，需要 employee:view_salary */
export async function getEmployeeSalary(employeeId: number) {
  const res = await pool.query(
    `SELECT salary_amount AS "salaryAmount", salary_type AS "salaryType",
            salary_source AS "salarySource"
     FROM employees WHERE id=$1`,
    [employeeId],
  );
  if (!res.rowCount) throw new NotFoundError("員工");
  return res.rows[0];
}

export async function getEmployee(employeeId: number, includeSalary = false) {
  const res = await pool.query(
    `SELECT e.*, d.name AS department_name, p.title AS position_title,
            u.username, u.role AS user_role
     FROM employees e
     LEFT JOIN departments d ON d.id=e.department_id
     LEFT JOIN positions p ON p.id=e.position_id
     LEFT JOIN users u ON u.id=e.user_id
     WHERE e.id=$1`,
    [employeeId],
  );
  if (!res.rowCount) throw new NotFoundError("員工");
  const row = { ...res.rows[0] };
  if (!includeSalary) {
    delete row.salary_amount;
    delete row.salary_type;
    delete row.salary_source;
  }

  const entitlements = await ensureEntitlements(employeeId);
  return { ...row, entitlements };
}

/* ── 請假 ─────────────────────────────────────────────── */

/**
 * 特休折發工資的金額。
 * 施行細則 §24-1：按「最近一個月正常工作時間所得之工資」除以 30 計算，
 * 不含加班費。
 */
export function payoutAmount(monthlySalary: number, days: number): number {
  return Math.round((monthlySalary / 30) * days);
}

export const LEAVE_TYPES = [
  "annual", "sick", "personal", "official",
  "maternity", "paternity", "compassionate", "unpaid",
] as const;

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  annual: "特別休假", sick: "病假", personal: "事假", official: "公假",
  maternity: "產假", paternity: "陪產假", compassionate: "喪假", unpaid: "無薪假",
};

export async function listLeaveRequests(filters: {
  employeeId?: number; status?: string; limit?: number;
} = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); where.push(`l.employee_id=$${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`l.status=$${params.length}`); }

  const res = await pool.query(
    `SELECT l.id, l.leave_type AS "leaveType", l.start_date AS "startDate",
            l.end_date AS "endDate", l.days, l.reason,
            l.trip_location AS "tripLocation", l.trip_type AS "tripType",
            l.status, l.rejection_reason AS "rejectionReason",
            l.approved_at AS "approvedAt", l.created_at AS "createdAt",
            e.id AS "employeeId", e.name AS "employeeName", e.employee_id AS "employeeCode",
            COALESCE(u.display_name, u.username) AS "approverName"
     FROM leave_requests l
     JOIN employees e ON e.id = l.employee_id
     LEFT JOIN users u ON u.id = l.approved_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.start_date DESC
     LIMIT ${Math.min(filters.limit ?? 100, 500)}`,
    params,
  );
  return res.rows;
}

export async function createLeaveRequest(
  input: {
    employeeId: number; leaveType: string; startDate: string; endDate: string;
    days: number; reason: string; tripLocation?: string; tripType?: string;
  },
  actor: Actor,
) {
  if (!LEAVE_TYPES.includes(input.leaveType as never)) {
    throw new ValidationError(`未知的假別：${input.leaveType}`);
  }
  if (input.endDate < input.startDate) {
    throw new ValidationError("結束日期不能早於開始日期");
  }
  if (!(input.days > 0)) throw new ValidationError("請假天數要大於 0");

  return transaction(async client => {
    // 特休要檢查額度夠不夠
    if (input.leaveType === "annual") {
      const entitlements = await ensureEntitlements(input.employeeId, undefined, client);
      const current = entitlements.find(e => e.isCurrent);
      if (!current) {
        throw new ConflictError("查不到目前年度的特休額度，請確認到職日是否正確");
      }
      if (input.days > current.remaining) {
        throw new ConflictError(
          `特休不足。本年度可用 ${current.available} 天、已用 ${current.used_days} 天、` +
          `剩餘 ${current.remaining} 天，這次申請 ${input.days} 天。`,
          { available: current.available, remaining: current.remaining },
        );
      }
    }

    const res = await client.query(
      `INSERT INTO leave_requests
         (employee_id, leave_type, start_date, end_date, days, reason,
          trip_location, trip_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
      [
        input.employeeId, input.leaveType, input.startDate, input.endDate,
        input.days, input.reason, input.tripLocation ?? null, input.tripType ?? null,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'leave_request',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id, JSON.stringify(input)],
    );
    return res.rows[0];
  });
}

export async function decideLeaveRequest(
  leaveId: number,
  decision: "approved" | "rejected",
  actor: Actor,
  reason?: string,
) {
  return transaction(async client => {
    const res = await client.query(
      "SELECT * FROM leave_requests WHERE id=$1 FOR UPDATE",
      [leaveId],
    );
    if (!res.rowCount) throw new NotFoundError("請假申請");
    const leave = res.rows[0];

    if (leave.status !== "pending") {
      throw new ConflictError(
        `這筆申請已經是「${leave.status === "approved" ? "已核准" : "已駁回"}」，不能重複審核`,
      );
    }
    if (decision === "rejected" && !reason?.trim()) {
      // 駁回一定要給理由，否則申請人只能用猜的
      throw new ValidationError("駁回時必須填寫理由");
    }

    // 特休：核准的當下再檢查一次額度。
    // 申請當下的檢查只看「已核准」的天數，所以兩張都還在待審的單子
    // 可能各自都通過申請檢查（例如剩 15 天，兩張各 10 天）。
    // 真正會扣掉額度的是「核准」這個動作，所以把關要放在這裡：
    // 第一張核准後額度就少了，第二張核准時就會被這道檢查擋下來。
    if (decision === "approved" && leave.leave_type === "annual") {
      const entitlements = await ensureEntitlements(leave.employee_id, undefined, client);
      const current = entitlements.find(e => e.isCurrent);
      if (!current) {
        throw new ConflictError("查不到目前年度的特休額度，無法核准");
      }
      if (Number(leave.days) > current.remaining) {
        throw new ConflictError(
          `核准後會超出特休額度。本年度可用 ${current.available} 天、` +
          `已核准 ${current.used_days} 天、剩餘 ${current.remaining} 天，` +
          `這筆是 ${Number(leave.days)} 天。請與員工協調調整天數或改用其他假別。`,
          { available: current.available, remaining: current.remaining },
        );
      }
    }

    await client.query(
      `UPDATE leave_requests
       SET status=$1, approved_by=$2, approved_at=now(),
           rejection_reason=$3, updated_at=now()
       WHERE id=$4`,
      [decision, actor.userId, decision === "rejected" ? reason : null, leaveId],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'leave_request',$3,'status_change',$4)`,
      [actor.userId, actor.label, leaveId, JSON.stringify({ from: "pending", to: decision, reason })],
    );

    // 特休核准後額度要重算（用同一條交易連線，確保跟上面的 UPDATE 一起生效）
    if (decision === "approved" && leave.leave_type === "annual") {
      await ensureEntitlements(leave.employee_id, undefined, client);
    }
    return { id: leaveId, status: decision };
  });
}

/* ── 出勤 ─────────────────────────────────────────────── */

export async function listAttendance(filters: {
  employeeId?: number; from?: string; to?: string;
} = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.employeeId) { params.push(filters.employeeId); where.push(`a.employee_id=$${params.length}`); }
  if (filters.from) { params.push(filters.from); where.push(`a.work_date >= $${params.length}`); }
  if (filters.to) { params.push(filters.to); where.push(`a.work_date <= $${params.length}`); }

  const res = await pool.query(
    `SELECT a.id, a.work_date AS "workDate", a.clock_in_at AS "clockInAt",
            a.clock_out_at AS "clockOutAt", a.work_minutes AS "workMinutes",
            a.overtime_minutes AS "overtimeMinutes", a.status, a.notes,
            e.id AS "employeeId", e.name AS "employeeName", e.employee_id AS "employeeCode",
            (SELECT count(*) FROM attendance_audit aa WHERE aa.attendance_id=a.id)::int AS "editCount"
     FROM attendance a
     JOIN employees e ON e.id = a.employee_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.work_date DESC, e.employee_id`,
    params,
  );
  return res.rows;
}

/**
 * 出勤日一律以台灣時間（UTC+8）計算。
 * 直接用 UTC 日期的話，台灣清晨（例如早上 7 點 = 前一天 23:00 UTC）
 * 打的卡會被記到前一天，跨日班別的下班卡也會對不上。
 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiWorkDate(at: Date): string {
  return new Date(at.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

export async function clockIn(employeeId: number, actor: Actor, at = new Date()) {
  const workDate = taipeiWorkDate(at);
  const res = await pool.query(
    `INSERT INTO attendance (employee_id, work_date, clock_in_at, status)
     VALUES ($1,$2,$3,'present')
     ON CONFLICT (employee_id, work_date) DO NOTHING
     RETURNING *`,
    [employeeId, workDate, at],
  );
  if (!res.rowCount) {
    throw new ConflictError("今天已經打過上班卡了。若要修改請用「補登」功能，會留下紀錄。");
  }
  return res.rows[0];
}

export async function clockOut(employeeId: number, actor: Actor, at = new Date()) {
  // 用「這位員工最近一筆還沒打下班卡的紀錄」來配對，而不是拿下班時間算出來的日期去比對。
  // 跨日班別（例如 23:30 上班、隔天 00:30 下班）用日期比對會找不到那一列，
  // 導致該班永遠無法收班。工時本身用時間戳相減，跨日也算得對。
  const res = await pool.query(
    `UPDATE attendance
     SET clock_out_at=$1,
         work_minutes = CASE WHEN clock_in_at IS NOT NULL
           THEN GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamp - clock_in_at))/60)::int
           ELSE work_minutes END,
         updated_at=now()
     WHERE id = (
       SELECT id FROM attendance
       WHERE employee_id=$2 AND clock_out_at IS NULL AND clock_in_at IS NOT NULL
       ORDER BY clock_in_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [at, employeeId],
  );
  if (!res.rowCount) {
    throw new ConflictError("找不到還沒打下班卡的上班紀錄。請確認是否已經打過上班卡。");
  }
  return res.rows[0];
}

/**
 * 補登或修改出勤。
 *
 * 勞基法 §30 要求出勤紀錄逐日記載至分鐘、保存 5 年。實務上勞檢最看的是
 * 「改過的紀錄能不能還原」—— 所以這裡強制寫入 attendance_audit，
 * 記下原值、新值、修改人與事由。舊系統直接覆蓋，什麼都查不到。
 */
export async function amendAttendance(
  attendanceId: number,
  changes: { clockInAt?: string | null; clockOutAt?: string | null; status?: string; notes?: string },
  reason: string,
  actor: Actor,
) {
  if (!reason?.trim()) {
    throw new ValidationError("修改出勤紀錄必須填寫事由（這是勞檢會查的項目）");
  }

  return transaction(async client => {
    const res = await client.query(
      "SELECT * FROM attendance WHERE id=$1 FOR UPDATE",
      [attendanceId],
    );
    if (!res.rowCount) throw new NotFoundError("出勤紀錄");
    const before = res.rows[0];

    const fields: Array<[string, string, unknown, unknown]> = [];
    if (changes.clockInAt !== undefined) fields.push(["clock_in_at", "上班時間", before.clock_in_at, changes.clockInAt]);
    if (changes.clockOutAt !== undefined) fields.push(["clock_out_at", "下班時間", before.clock_out_at, changes.clockOutAt]);
    if (changes.status !== undefined) fields.push(["status", "狀態", before.status, changes.status]);
    if (changes.notes !== undefined) fields.push(["notes", "備註", before.notes, changes.notes]);

    if (fields.length === 0) throw new ValidationError("沒有任何要修改的欄位");

    for (const [column, , , value] of fields) {
      await client.query(`UPDATE attendance SET ${column}=$1, updated_at=now() WHERE id=$2`,
        [value, attendanceId]);
    }

    // 時間有動就重算工時
    await client.query(
      `UPDATE attendance
       SET work_minutes = CASE
         WHEN clock_in_at IS NOT NULL AND clock_out_at IS NOT NULL
         THEN GREATEST(0, EXTRACT(EPOCH FROM (clock_out_at - clock_in_at))/60)::int
         ELSE NULL END
       WHERE id=$1`,
      [attendanceId],
    );

    for (const [column, label, oldValue, newValue] of fields) {
      await client.query(
        `INSERT INTO attendance_audit
           (attendance_id, field_name, old_value, new_value, reason, changed_by, changed_by_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          attendanceId, label,
          oldValue == null ? null : String(oldValue),
          newValue == null ? null : String(newValue),
          reason, actor.userId, actor.label,
        ],
      );
    }

    return { attendanceId, changed: fields.map(f => f[1]) };
  });
}

export async function getAttendanceHistory(attendanceId: number) {
  const res = await pool.query(
    `SELECT field_name AS "field", old_value AS "oldValue", new_value AS "newValue",
            reason, changed_by_label AS "changedBy", changed_at AS "changedAt"
     FROM attendance_audit WHERE attendance_id=$1 ORDER BY changed_at DESC`,
    [attendanceId],
  );
  return res.rows;
}

/* ── 部門與職位（員工表單的下拉來源）───────────────────── */

export async function listDepartments() {
  const r = await pool.query(`SELECT id, name FROM departments ORDER BY name`);
  return r.rows;
}

export async function listPositions() {
  const r = await pool.query(
    `SELECT id, title, department_id AS "departmentId" FROM positions ORDER BY title`,
  );
  return r.rows;
}

/** 用名稱找部門，沒有就建一個，回傳 id。空字串回 null。 */
async function resolveDepartment(client: PoolClient, name?: string | null): Promise<number | null> {
  const n = (name ?? "").trim();
  if (!n) return null;
  const found = await client.query(`SELECT id FROM departments WHERE name=$1`, [n]);
  if (found.rowCount) return found.rows[0].id;
  const ins = await client.query(`INSERT INTO departments (name) VALUES ($1) RETURNING id`, [n]);
  return ins.rows[0].id;
}

/** 用名稱找職位，沒有就建一個，回傳 id。 */
async function resolvePosition(client: PoolClient, title?: string | null, departmentId?: number | null): Promise<number | null> {
  const t = (title ?? "").trim();
  if (!t) return null;
  const found = await client.query(`SELECT id FROM positions WHERE title=$1`, [t]);
  if (found.rowCount) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO positions (title, department_id) VALUES ($1,$2) RETURNING id`,
    [t, departmentId ?? null],
  );
  return ins.rows[0].id;
}

/* ── 員工主檔：新增與修改 ───────────────────────────────
   舊系統只能看不能改，人事一異動就得直接進資料庫。這裡補上完整的
   新增／編輯，並比照其他寫入端：權限把關在路由層、每筆變更寫稽核。
   薪資是敏感欄位，是否能寫由路由層依 employee:view_salary 決定，
   這一層只負責「有給就寫、沒給就不動」。 */

export interface EmployeeInput {
  employeeId: string;
  name: string;
  email: string;
  phone?: string | null;
  hireDate: string;
  terminationDate?: string | null;
  departmentName?: string | null;
  positionName?: string | null;
  employmentType?: string;         // full_time | part_time
  monthlyWorkHours?: number | null;
  contractEndDate?: string | null;
  partnerName?: string | null;
  requiresClockIn?: boolean;
  salaryAmount?: number | null;    // 敏感，路由層決定是否允許
  salaryType?: string;             // monthly | hourly
}

const EMPLOYMENT_TYPES = ["full_time", "part_time"];

export async function createEmployee(input: EmployeeInput, actor: Actor, allowSalary: boolean) {
  if (!input.employeeId?.trim()) throw new ValidationError("員工編號為必填");
  if (!input.name?.trim()) throw new ValidationError("姓名為必填");
  if (!input.email?.trim()) throw new ValidationError("Email 為必填");
  if (!input.hireDate) throw new ValidationError("到職日為必填");
  if (input.employmentType && !EMPLOYMENT_TYPES.includes(input.employmentType)) {
    throw new ValidationError("僱用型態不正確");
  }
  if (input.contractEndDate && input.contractEndDate < input.hireDate) {
    throw new ValidationError("合約到期日不能早於到職日");
  }

  return transaction(async client => {
    const dup = await client.query(`SELECT id FROM employees WHERE employee_id=$1`, [input.employeeId.trim()]);
    if (dup.rowCount) throw new ConflictError(`員工編號「${input.employeeId.trim()}」已經存在`);

    const departmentId = await resolveDepartment(client, input.departmentName);
    const positionId = await resolvePosition(client, input.positionName, departmentId);

    const res = await client.query(
      `INSERT INTO employees
         (employee_id, name, email, phone, hire_date, termination_date,
          department_id, position_id, employment_type, monthly_work_hours,
          contract_end_date, partner_name, requires_clock_in,
          salary_amount, salary_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.employeeId.trim(), input.name.trim(), input.email.trim(),
        input.phone?.trim() || null, input.hireDate, input.terminationDate || null,
        departmentId, positionId, input.employmentType || "full_time",
        input.monthlyWorkHours ?? null, input.contractEndDate || null,
        input.partnerName?.trim() || null,
        input.requiresClockIn ?? true,
        allowSalary ? (input.salaryAmount ?? null) : null,
        allowSalary ? (input.salaryType || "monthly") : "monthly",
      ],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'employee',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id,
       JSON.stringify({ employeeId: input.employeeId, name: input.name })],
    );
    // 帳號先建好的話（帳號 = 員編或 email 相同），順手對上
    await linkEmployeesToUsers(client as never, { employeeId: res.rows[0].id });

    return res.rows[0];
  });
}

export async function updateEmployee(id: number, patch: Partial<EmployeeInput>, actor: Actor, allowSalary: boolean) {
  if (patch.employmentType && !EMPLOYMENT_TYPES.includes(patch.employmentType)) {
    throw new ValidationError("僱用型態不正確");
  }

  return transaction(async client => {
    const cur = await client.query(`SELECT * FROM employees WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rowCount) throw new NotFoundError("員工");
    const before = cur.rows[0];

    // 員編改動要檢查不撞號
    if (patch.employeeId && patch.employeeId.trim() !== before.employee_id) {
      const dup = await client.query(
        `SELECT id FROM employees WHERE employee_id=$1 AND id<>$2`, [patch.employeeId.trim(), id]);
      if (dup.rowCount) throw new ConflictError(`員工編號「${patch.employeeId.trim()}」已經被其他人使用`);
    }

    const hireDate = patch.hireDate ?? before.hire_date;
    const contractEnd = patch.contractEndDate !== undefined ? patch.contractEndDate : before.contract_end_date;
    if (contractEnd && String(contractEnd) < String(hireDate)) {
      throw new ValidationError("合約到期日不能早於到職日");
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

    if (patch.employeeId !== undefined) put("employee_id", patch.employeeId.trim());
    if (patch.name !== undefined) put("name", patch.name.trim());
    if (patch.email !== undefined) put("email", patch.email.trim());
    if (patch.phone !== undefined) put("phone", patch.phone?.trim() || null);
    if (patch.hireDate !== undefined) put("hire_date", patch.hireDate);
    if (patch.terminationDate !== undefined) put("termination_date", patch.terminationDate || null);
    if (patch.employmentType !== undefined) put("employment_type", patch.employmentType);
    if (patch.monthlyWorkHours !== undefined) put("monthly_work_hours", patch.monthlyWorkHours);
    if (patch.contractEndDate !== undefined) put("contract_end_date", patch.contractEndDate || null);
    if (patch.partnerName !== undefined) put("partner_name", patch.partnerName?.trim() || null);
    if (patch.requiresClockIn !== undefined) put("requires_clock_in", patch.requiresClockIn);

    if (patch.departmentName !== undefined) {
      const deptId = await resolveDepartment(client, patch.departmentName);
      put("department_id", deptId);
    }
    if (patch.positionName !== undefined) {
      const posId = await resolvePosition(client, patch.positionName, null);
      put("position_id", posId);
    }
    // 薪資：只有被允許時才動
    if (allowSalary && patch.salaryAmount !== undefined) put("salary_amount", patch.salaryAmount);
    if (allowSalary && patch.salaryType !== undefined) put("salary_type", patch.salaryType);

    if (!sets.length) return before;

    vals.push(id);
    const res = await client.query(
      `UPDATE employees SET ${sets.join(", ")}, updated_at=now() WHERE id=$${vals.length} RETURNING *`,
      vals,
    );

    // 稽核：記錄改了哪些欄位（薪資只記「有動過」，不把金額寫進日誌）
    const changed = sets.map(s => s.split("=")[0]).filter(c => c !== "updated_at");
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'employee',$3,'update',$4)`,
      [actor.userId, actor.label, id, JSON.stringify({ fields: changed })],
    );

    return res.rows[0];
  });
}
