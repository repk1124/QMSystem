/** 人事：特休計算與出勤留痕測試 */
import { pool } from "../server/db";
import {
  annualLeaveDays, anniversaryPeriod, ensureEntitlements,
  createLeaveRequest, decideLeaveRequest, listLeaveRequests,
  clockIn, clockOut, amendAttendance, getAttendanceHistory, listAttendance,
} from "../server/repositories/hr";
import { ConflictError, ValidationError } from "../server/errors";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n} ${e}`); fail++; } };
const eq = (n: string, a: unknown, b: unknown) => ok(n, String(a) === String(b), `期望 ${b}，實得 ${a}`);
async function expectError(n: string, Type: unknown, fn: () => Promise<unknown>) {
  try { await fn(); ok(n, false, "（應該被擋下卻成功了）"); }
  catch (e) { ok(n, e instanceof (Type as never), `拋出 ${(e as Error).constructor.name}: ${(e as Error).message}`); }
}
const actor = { userId: null, label: "測試" };

async function main() {
  // 測試要能重複執行。上一輪留下的請假與打卡紀錄會讓額度與工時對不上，
  // 所以先清掉這支測試自己產生的資料（用固定的測試日期與事由辨識）。
  await pool.query("DELETE FROM attendance_audit WHERE reason LIKE '%打卡機當機%'");
  await pool.query("DELETE FROM attendance WHERE work_date = '2026-08-14'");
  await pool.query("DELETE FROM leave_requests WHERE reason LIKE '測試%'");
  await pool.query("DELETE FROM leave_entitlements");

  console.log("\n── 1. 特休天數（勞基法 §38）──");
  const table: [number, number][] = [
    [0.4, 0], [0.5, 3], [0.9, 3], [1, 7], [1.9, 7], [2, 10],
    [3, 14], [4.9, 14], [5, 15], [9.9, 15], [10, 16], [11, 17],
    [23, 29], [24, 30], [30, 30], [40, 30],
  ];
  for (const [years, expected] of table) {
    eq(`年資 ${years} 年 → ${expected} 天`, annualLeaveDays(years), expected);
  }

  console.log("\n── 2. 週年制區間 ──");
  {
    const p0 = anniversaryPeriod("2023-09-01", 0);
    eq("第 1 年起", p0.start, "2023-09-01");
    eq("第 1 年迄", p0.end, "2024-08-31");
    const p2 = anniversaryPeriod("2023-09-01", 2);
    eq("第 3 年起", p2.start, "2025-09-01");
    eq("第 3 年迄", p2.end, "2026-08-31");
  }

  console.log("\n── 3. 用 seed 的員工算特休 ──");
  const emp = await pool.query("SELECT id, name, hire_date FROM employees WHERE employee_id='001'");
  if (!emp.rowCount) { ok("找得到員工 001（王小明）", false, "測試資料沒有，請先跑 scripts/ci-seed.ts"); }
  else {
    const employeeId = emp.rows[0].id;
    const list = await ensureEntitlements(employeeId, "2026-08-15");
    ok("產生了多個年度", list.length >= 3, `${list.length} 個`);
    const current = list.find(e => e.isCurrent);
    ok("找得到目前年度", current != null);
    if (current) {
      console.log(`     目前年度 ${current.period_start}～${current.period_end}：` +
        `法定 ${current.entitled_days} 天、遞延 ${current.carried_in_days} 天、` +
        `已用 ${current.used_days} 天、剩餘 ${current.remaining} 天`);
      // 2023-09-01 到職，2026-08-15 時是第 3 個年度（滿 2 年未滿 3 年）→ 10 天
      eq("第 3 年度法定天數", Number(current.entitled_days), 10);
    }

    console.log("\n── 3b. 遞延只能一次，過期要折發工資 ──");
  {
    // 到職 2023-09-01，到 2026-08-15 為止完全沒休過：
    //   第1年度 2023-09~2024-08：法定 3 天，未休 → 遞延 3 天
    //   第2年度 2024-09~2025-08：法定 7 天 + 遞延 3 天 = 10 天可用，未休
    //     → 只有「當年度的 7 天」可以再遞延；
    //       已經遞延過一次的 3 天必須折發工資，不能再滾
    //   第3年度 2025-09~2026-08：遞延進來應該是 7 天，不是 10 天
    const employeeId2 = emp.rows[0].id;
    const all = await ensureEntitlements(employeeId2, "2026-08-15");
    const y1 = all[0], y2 = all[1], y3 = all[2];
    eq("第1年度法定 3 天", Number(y1.entitled_days), 3);
    eq("第1年度遞延出 3 天", Number(y1.carried_out_days), 3);
    eq("第2年度法定 7 天", Number(y2.entitled_days), 7);
    eq("第2年度遞延進 3 天", Number(y2.carried_in_days), 3);
    eq("第2年度只能再遞延當年度的 7 天", Number(y2.carried_out_days), 7);
    eq("第2年度有 3 天要折發工資", Number(y2.paid_out_days), 3);
    eq("第3年度遞延進 7 天（不是 10 天）", Number(y3.carried_in_days), 7);
  }

  console.log("\n── 4. 特休超額申請會被擋下 ──");
    await expectError("申請 99 天特休", ConflictError, () => createLeaveRequest({
      employeeId, leaveType: "annual", startDate: "2026-08-20", endDate: "2026-12-20",
      days: 99, reason: "測試超額",
    }, actor));

    console.log("\n── 5. 請假流程 ──");
    const created = await createLeaveRequest({
      employeeId, leaveType: "annual", startDate: "2026-08-20", endDate: "2026-08-21",
      days: 2, reason: "測試特休",
    }, actor);
    ok("建立成功且為待審", created.status === "pending");

    await expectError("駁回不給理由被擋", ValidationError,
      () => decideLeaveRequest(created.id, "rejected", actor));

    const decided = await decideLeaveRequest(created.id, "approved", actor);
    eq("核准成功", decided.status, "approved");

    await expectError("重複審核被擋", ConflictError,
      () => decideLeaveRequest(created.id, "rejected", actor, "改變主意"));

    const after = await ensureEntitlements(employeeId, "2026-08-15");
    const cur = after.find(e => e.isCurrent);
    eq("核准後已用天數增加", Number(cur!.used_days), 2);
    eq("剩餘天數減少", cur!.remaining, Number(cur!.entitled_days) + Number(cur!.carried_in_days) - 2);

    console.log("\n── 5b. 折發工資金額（施行細則 §24-1）──");
    const { payoutAmount } = await import("../server/repositories/hr");
    eq("月薪 30000、折 3 天", payoutAmount(30000, 3), 3000);
    eq("月薪 45500、折 5 天", payoutAmount(45500, 5), Math.round(45500 / 30 * 5));

    console.log("\n── 6. 假別驗證 ──");
    await expectError("未知假別被擋", ValidationError, () => createLeaveRequest({
      employeeId, leaveType: "vacation", startDate: "2026-09-01", endDate: "2026-09-01",
      days: 1, reason: "x" }, actor));
    await expectError("結束早於開始被擋", ValidationError, () => createLeaveRequest({
      employeeId, leaveType: "personal", startDate: "2026-09-05", endDate: "2026-09-01",
      days: 1, reason: "x" }, actor));

    console.log("\n── 7. 出勤打卡與留痕（勞基法 §30）──");
    const at = new Date("2026-08-14T01:00:00Z");
    const rec = await clockIn(employeeId, actor, at);
    ok("上班打卡", rec.id > 0);
    await expectError("重複打卡被擋", ConflictError, () => clockIn(employeeId, actor, at));

    await clockOut(employeeId, actor, new Date("2026-08-14T10:00:00Z"));
    const list2 = await listAttendance({ employeeId, from: "2026-08-14", to: "2026-08-14" });
    eq("工時 9 小時 = 540 分", list2[0].workMinutes, 540);
    eq("尚未被修改過", list2[0].editCount, 0);

    await expectError("修改不給事由被擋", ValidationError,
      () => amendAttendance(rec.id, { clockInAt: "2026-08-14T00:30:00Z" }, "", actor));

    await amendAttendance(rec.id,
      { clockInAt: "2026-08-14T00:30:00Z" }, "員工反映打卡機當機，依門禁紀錄補正", actor);

    const history = await getAttendanceHistory(rec.id);
    eq("留下一筆修改紀錄", history.length, 1);
    eq("記錄了欄位名稱", history[0].field, "上班時間");
    ok("保留了原始值", history[0].oldValue != null && history[0].oldValue !== "");
    ok("記錄了事由", String(history[0].reason).includes("打卡機當機"));

    const list3 = await listAttendance({ employeeId, from: "2026-08-14", to: "2026-08-14" });
    eq("修改後工時重算為 570 分", list3[0].workMinutes, 570);
    eq("修改次數顯示為 1", list3[0].editCount, 1);
  }

  console.log(`\n════════ 通過 ${pass}／失敗 ${fail} ════════`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error("\n測試失敗:", e); await pool.end(); process.exit(1); });
