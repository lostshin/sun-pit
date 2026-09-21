# 貢獻指南

感謝你協助改善 順筆。本專案維持零第三方 JavaScript 依賴、無 build step 的 Chrome Manifest V3 架構。

順筆的理念是「直接把社群軟體當成筆記軟體」。新增功能應讓發文自然成為記筆記，減少切換工具與事後整理的步驟。

## 開始前

- 使用目前仍受支援的 Node.js LTS 或 Current 版本。
- 安裝 Google Chrome；只有測試 Local REST API 目的地時才需要 Obsidian。
- macOS 預設使用 Native Helper；從 repository 根目錄執行 `./native/install-host.sh`。其他系統或 REST 相關開發再安裝 [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)。
- Fork repository，從 `main` 建立用途明確的 branch。
- 不要在 issue、PR、測試資料或 log 中提交 API Key、私人貼文、cookies 或完整平台回應。

## 開發原則

- 只加入目前功能需要的最小權限，不使用 `<all_urls>`。
- 平台回應與使用者內容不得傳送到開發者或第三方伺服器。
- 不得加入遠端執行程式碼、`eval()`、`new Function()` 或外部 JavaScript。
- 優先擴充 `tests/media-sync.test.mjs`，避免建立重複測試工具。
- 程式行為變更必須同步更新 `manifest.json.version`：bug fix bump patch；新功能或可見行為 bump minor。純文件、測試與註解不 bump。
- 變更 content script 後，必須在 `chrome://extensions/` 重新載入擴充功能，並重新整理所有已開啟的 X／Threads 分頁。

## 驗證

提交前至少執行：

```bash
node scripts/validate-extension.mjs
node tests/media-sync.test.mjs
./scripts/package-extension.sh
git diff --check
```

若變更會影響實際存檔，請另外確認：

1. X 與 Threads 的草稿狀態正常。
2. 發佈後 Markdown 最後寫入，圖片先寫入自訂的圖片路徑。
3. Obsidian 未連線時會排隊，恢復連線後能補存。
4. Chrome 擴充功能錯誤頁與頁面 console 沒有新 error。

請勿為了測試自行替他人發佈貼文；真實發文必須由帳號持有人操作。

## Pull request

PR 請保持單一目的，並說明：

- 問題與解法。
- 受影響的平台與使用情境。
- 執行過的自動測試與手動驗證。
- 是否新增權限、資料處理方式或 Chrome Web Store 揭露事項。

## 維護者發布流程

1. 確認 `main` 全部驗證通過，且 `manifest.json.version` 是要發布的版本。
2. 在本機執行 `./scripts/package-extension.sh`，確認 extension ZIP、macOS Helper ZIP 與 `SHA256SUMS` 都已產生。
3. 以解壓縮後的 `dist/sun-pit-v*.zip` 做最後一次 Load unpacked 測試，並依 [`INSTALL.md`](INSTALL.md) 驗證 Helper 安裝流程。
4. 建立與 Manifest 一致的 tag，例如 `v2.2.0`，再 push tag。
5. GitHub Actions 會重跑驗證、建立兩個乾淨 ZIP 與 checksum，並發布 GitHub Release。
6. 將 extension ZIP 上傳 Chrome Web Store；不要上傳 Helper ZIP。欄位、權限揭露與 reviewer instructions 見 [`docs/CHROME_WEB_STORE.md`](docs/CHROME_WEB_STORE.md)。
