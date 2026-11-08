# 貢獻指南

歡迎 issue 與 PR。語言：issue／PR／註解請用繁體中文（英文亦可）。

## 開發流程

1. Fork 後開分支：`git checkout -b feat/簡短描述`
2. 依 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) 起環境
3. 提交前確認：`npm run check`、`npm run build`、`npm test`、`npm run test:e2e` 全過
4. 改到 schema 要附 migration（`npm run db:generate`），改到路由要在 `tests/e2e-api.test.ts` 補案例
5. PR 描述寫清楚「為什麼」與怎麼驗證；CI（GitHub Actions）會跑型別檢查、build、測試與 docker build

## 準則

- 遵守 `CLAUDE.md` 的慣例（也適用於人類）
- 不要放任何真實公司、客戶、個人資料；範例用「範例公司」「王小明」
- UI 文案用台灣用語；日期顯示 `zh-TW`
- 一個 PR 做一件事；大改動先開 issue 討論

## 回報安全問題

請不要公開開 issue，依 [SECURITY.md](SECURITY.md) 處理。
