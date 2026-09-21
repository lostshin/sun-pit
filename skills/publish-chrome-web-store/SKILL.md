---
name: publish-chrome-web-store
description: Safely publish or resume publishing a Chrome extension update through Chrome Web Store. Use when asked to 上架、更新、送審、重新送審、續傳或確認 Chrome Web Store 版本，尤其是 GitHub Release 已完成、tag 不可重建或移動時。Verifies the exact Release extension ZIP against SHA256SUMS, keeps Helper packages out of the upload, controls the signed-in Chrome dashboard, distinguishes draft/review/live states, and records evidence without claiming publication too early.
---

# Publish Chrome Web Store

把既有 GitHub Release 視為唯一套件來源，安全完成 Chrome Web Store 的上傳、儲存、送審與狀態驗收。不要重建套件、重打或移動 tag，也不要把 Dashboard 的「已發布」誤認成新版本已公開。

## 不可破壞的契約

- 先讀專案規則、執行 `git status --short`，保留使用者既有變更。
- Release 已完成時，不執行 build、package、retag、delete tag、move tag 或重新產生 checksum。
- 只上傳同一份 Release 中通過 `SHA256SUMS` 驗證的 extension ZIP；不使用同名本機產物，不上傳 Helper、Native Host 或 installer ZIP。
- 在送審前讀回草稿版本、權限、隱私與發布範圍。權限增加或 listing 資料不完整時停下回報。
- 「已提交審查／待審查」不等於「已公開」。只有匿名商店頁、update service 與隔離安裝均確認新版後，才能宣稱公開。
- 遇到 CAPTCHA、開發者協議、付款、註冊頁或錯誤帳戶時停止，交由使用者處理；不代勾、不付款、不繞過驗證。

## 工作流程

### 1. 確認發布身分

從專案與使用者要求取得以下資料，不靠猜測：

- tag 與預期版本，例如 `v2.15.6` → `2.15.6`
- extension Release asset 的精確檔名
- Chrome Web Store item ID、publisher 帳戶與目前公開版本
- 是否要勾選「通過審查後自動發布」；「上架」通常代表要勾，單純「送審」則需依使用者指示

若缺少 asset 名稱，先用 `gh release view <tag>` 唯讀檢查。不要因本機 `dist/` 有同名 ZIP 就採用它。

### 2. 驗證 Release 套件

從此 skill 目錄執行：

```bash
bash scripts/verify-release-asset.sh <tag> <extension-asset.zip> [owner/repo]
```

腳本會下載該 Release 的精確 asset 與 `SHA256SUMS` 到新建暫存目錄，拒絕 draft／prerelease，核對 SHA-256，並確認根目錄 `manifest.json` 的版本等於 tag。保留它輸出的 `VERIFIED_ASSET`、`SHA256`、`VERSION` 作為送審證據。

若檔案選擇器不能從暫存目錄開檔，建立一份位元完全相同、且不覆寫既有檔案的上傳副本：

```bash
bash scripts/stage-upload-copy.sh \
  <verified-asset.zip> <existing-destination-dir> <expected-sha256> [new-name.zip]
```

這只是 `cp` 已驗證的 Release asset，不是重新封裝。重新核對腳本輸出的目的檔 hash 後才上傳。

### 3. 操作 Dashboard

優先使用具有既有登入狀態的 Chrome 控制工具。若 Chrome Web Store 回報 gallery 無法被 script 控制，不要原樣重試；在已有使用者授權時切換到本機電腦控制，否則先取得授權。

完整 UI 步驟、檔案選擇器技巧、停手條件與狀態語意見 [references/dashboard-workflow.md](references/dashboard-workflow.md)。核心順序固定為：

1. 確認 publisher、item ID 與目前公開版本。
2. 進入套件頁上傳已驗證 ZIP；等待進度完成並讀回草稿版本。
3. 比對新舊權限，檢查狀態、隱私權與發布範圍頁。
4. 儲存草稿，等待成功訊息與「提交審查」可用。
5. 開啟送審確認視窗，依使用者意圖設定自動發布，再執行最終提交。
6. 等到明確的提交成功訊息，關閉對話框後再次讀回 `待審查`。

電腦控制的 accessibility element index 只對當下畫面有效；每次點擊、導頁、開關對話框或切換視窗後，都重新讀取 UI state 再操作。

### 4. 分層驗收

送審完成時只回報：

- 草稿／送審版本
- Dashboard 狀態（例如 `待審查`）
- 目前實際公開版本
- 自動發布是否啟用
- Release asset、SHA-256 與 manifest version
- repository 是否有變更、是否留下上傳副本
- 尚待人工或審查完成後確認的項目

可複製 [assets/handoff-template.md](assets/handoff-template.md) 作為交付格式。

審查通過後，另做公開驗收：

1. 匿名或登出狀態的商店頁顯示可安裝，且版本為目標版本。
2. Chrome update service 可取得目標版本。
3. 使用隔離 profile 安裝成功，manifest 版本正確。

三項未全部完成前，用「已送審」「審查通過」或「等待發布同步」描述，不用「已公開上架」。

## 資源路由

- Release asset 驗證：執行 `scripts/verify-release-asset.sh`，不需把腳本內容載入 context。
- 檔案選擇器用穩定副本：執行 `scripts/stage-upload-copy.sh`。
- Dashboard 操作、狀態與停手規則：讀 `references/dashboard-workflow.md`。
- 最終回報：複製並填寫 `assets/handoff-template.md`。
