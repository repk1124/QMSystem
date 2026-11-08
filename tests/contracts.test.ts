/** 合約與範本測試 */
import { pool } from "../server/db";
import {
  listTemplates, upsertTemplate, extractVariables, renderTemplate, missingVariables,
  templateValuesFromQuotation, createContract, updateContract, getContract,
  listContracts, changeContractStatus,
} from "../server/repositories/contracts";
import { ConflictError, ValidationError } from "../server/errors";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, e = "") => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n} ${e}`); fail++; } };
const eq = (n: string, a: unknown, b: unknown) => ok(n, String(a) === String(b), `期望 ${b}，實得 ${a}`);
async function expectError(n: string, T: unknown, fn: () => Promise<unknown>) {
  try { await fn(); ok(n, false, "（應被擋下）"); }
  catch (e) { ok(n, e instanceof (T as never), `拋出 ${(e as Error).constructor.name}`); }
}
const actor = { userId: null, label: "測試" };

async function main() {
  // 測試要能重複執行。上一輪的第 9 節會改到範本內容，
  // 不還原的話這一輪建立的合約就會帶著上次加的條款，
  // 「已簽合約不受範本修改影響」那項會假性失敗。
  await pool.query("DELETE FROM contracts WHERE contract_number LIKE 'CNT-%'");
  await pool.query(
    `UPDATE document_templates
     SET body = regexp_replace(body, E'\n\n第九條 本合約另訂補充條款\\.', '', 'g')
     WHERE code = 'DEV-DEFAULT'`);

  console.log("\n── 1. 範本變數解析 ──");
  {
    eq("抓出變數", extractVariables("甲方：{companyName}，乙方：{clientCompany}").join(","),
       "clientCompany,companyName");
    eq("重複只算一次", extractVariables("{a} {a} {b}").length, 2);
    eq("沒有變數時為空", extractVariables("純文字").length, 0);
  }

  console.log("\n── 2. 套用範本 ──");
  {
    const body = "甲方：{companyName}\n乙方：{clientCompany}\n代表人：{principalName}";
    const out = renderTemplate(body, { companyName: "範例公司", clientCompany: "範例大學" });
    ok("有值的被換掉", out.includes("範例公司") && out.includes("範例大學"));
    // 沒填的渲染成空字串，合約上不會留 {xxx} 字面值；缺了什麼由 missingVariables 提示
    ok("沒填的變成空字串", !out.includes("{principalName}") && out.endsWith("代表人："), out);
    ok("不會變成 undefined", !out.includes("undefined"));

    const missing = missingVariables(body, { companyName: "範例公司", clientCompany: "x" });
    eq("列出缺少的變數", missing.join(","), "principalName");
    eq("空字串也算缺少", missingVariables("{a}", { a: "" }).join(","), "a");
  }

  console.log("\n── 3. 資料庫裡的範本 ──");
  const templates = await listTemplates();
  eq("有兩份預設範本", templates.length, 2);
  const dev = templates.find(t => t.code === "DEV-DEFAULT");
  const rental = templates.find(t => t.code === "RENT-DEFAULT");
  ok("開發合約範本存在", dev != null);
  ok("租賃合約範本存在", rental != null);
  ok("變數有存下來", dev!.variables.length === 18, `${dev!.variables.length} 個`);

  console.log("\n── 4. 從報價產生合約內容（CI seed 造的那一筆）──");
  // 我方 Email／電話／代表人來自系統設定
  await pool.query(
    `UPDATE app_settings SET company_email='info@example.com', company_phone='02-00000000',
       company_principal='王大明' WHERE id=1`);
  await pool.query(`UPDATE companies SET principal='王大明' WHERE is_default = true`);
  const q = await pool.query(
    `SELECT id, quotation_number FROM quotations
     WHERE quotation_number='QT-20260811-399' LIMIT 1`);
  ok("找得到報價", q.rowCount === 1);
  const quotationId = q.rows[0].id;

  const values = await templateValuesFromQuotation(quotationId);
  eq("客戶名稱", values.clientCompany, "範例大學");
  eq("我方公司", values.companyName, "範例公司");
  eq("統編", values.buyerTaxId, "10000009");
  eq("我方 Email 取自設定", values.ourEmail, "info@example.com");
  eq("我方電話取自設定", values.ourPhone, "02-00000000");
  eq("代表人取自設定", values.principalName, "王大明");
  const rendered = renderTemplate(dev!.body, values);
  ok("套用後沒有 {ourEmail} / {principalName} 字面值", !/\{(ourEmail|principalName|ourPhone)\}/.test(rendered));
  ok("金額有格式化", String(values.totalAmount).includes(","), String(values.totalAmount));
  ok("品項描述有內容", String(values.lineItemsDescription).length > 0, values.lineItemsDescription);

  console.log("\n── 5. 分期金額加總要等於總額 ──");
  {
    const strip = (s: string) => Number(String(s).replace(/,/g, ""));
    const total = strip(values.totalAmount);
    const sum = strip(values.firstPayment) + strip(values.secondPayment) + strip(values.thirdPayment);
    eq("30%+40%+30% 剛好等於總額", sum, total);
    ok("不是各自四捨五入造成的誤差", sum === total, `${sum} vs ${total}`);
  }

  console.log("\n── 6. 建立合約 ──");
  const content = renderTemplate(dev!.body, values);
  const contract = await createContract({
    clientId: (await pool.query("SELECT client_id FROM quotations WHERE id=$1", [quotationId])).rows[0].client_id,
    companyId: 1, quotationId, templateId: dev!.id,
    contractType: "development", title: "多功能聊天機器人開發合約",
    content, startDate: "2026-09-01", endDate: "2026-12-31",
    totalAmount: 129998,
  }, actor);
  ok("編號格式", /^CNT-\d{8}-\d{3}$/.test(contract.contract_number), contract.contract_number);
  eq("初始狀態", contract.status, "draft");

  await expectError("結束早於開始被擋", ValidationError, () => createContract({
    clientId: contract.client_id, companyId: 1, contractType: "development",
    title: "x", content: "y", startDate: "2026-12-01", endDate: "2026-01-01",
  }, actor));

  console.log("\n── 7. 狀態機與鎖定 ──");
  {
    await expectError("draft 不能直接跳到 active", ConflictError,
      () => changeContractStatus(contract.id, "active", actor));

    await changeContractStatus(contract.id, "sent", actor);
    await changeContractStatus(contract.id, "signed", actor, { signedAt: "2026-08-25" });

    const after = await getContract(contract.id);
    eq("已簽署", after.status, "signed");
    eq("簽署日有記錄", after.signed_at, "2026-08-25");
    ok("簽署後自動鎖定", after.locked_at != null);

    await expectError("已簽署不能改內容", ConflictError,
      () => updateContract(contract.id, { content: "偷改條款" }, actor));

    const check = await getContract(contract.id);
    ok("內容沒有被改動", check.content === content);

    await changeContractStatus(contract.id, "active", actor);
    eq("可以進入履約中", (await getContract(contract.id)).status, "active");

    await expectError("履約中不能倒回已簽署", ConflictError,
      () => changeContractStatus(contract.id, "signed", actor));
  }

  console.log("\n── 8. 列表與到期查詢 ──");
  {
    const all = await listContracts();
    ok("查得到合約", all.length >= 1);
    eq("帶出客戶名稱", all[0].clientName, "範例大學");
    eq("帶出來源報價", all[0].quotationNumber, "QT-20260811-399");

    const expiring = await listContracts({ expiringDays: 200 });
    ok("到期查詢找得到", expiring.some(c => c.id === contract.id));

    const none = await listContracts({ status: "terminated" });
    eq("狀態篩選有效", none.length, 0);
  }

  console.log("\n── 9. 範本可以在系統裡修改 ──");
  {
    const updated = await upsertTemplate({
      id: dev!.id, name: dev!.name, templateType: "development",
      body: dev!.body + "\n\n第九條 本合約另訂補充條款。",
    }, actor);
    ok("修改成功", String(updated.body).includes("補充條款"));

    const reread = await getContract(contract.id);
    ok("已簽合約的內容不受範本修改影響", !String(reread.content).includes("補充條款"));
  }

  console.log(`\n════════ 通過 ${pass}／失敗 ${fail} ════════`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
main().catch(async e => { console.error("\n測試失敗:", e); await pool.end(); process.exit(1); });
