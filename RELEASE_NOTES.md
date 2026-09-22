# 2.19.2 候選版

日期：2026-09-22。GitHub repository 與 About 已更名為 `lostshin/sun-pit`；商店新版名稱、文案與素材尚未上傳。這是 `2.19.2` 發布候選版，尚未建立 tag、上傳 GitHub Release 或提交 Chrome Web Store。Native Helper 維持 1.10.0，最低需求也是 1.10.0；storage schema 維持 v3。

## 使用者可見變更

- 專案更名為「順筆 sun-pit」，定位為「直接把社群軟體當成筆記軟體」。同步更新介面、中英文文件、商店文案與套件名稱；Chrome extension ID 與既有筆記保留，Native Host ID 與設定目錄改為 sun-pit，需重新安裝 Helper。

- Popup 新增「背景作業」，顯示目前目的地的最近封存結果、移動／略過筆數、失敗原因、最後成功時間與下次預定時間。關閉 Popup 後紀錄仍保留。
- 新增「檢查目前目的地」與確認修復索引。先唯讀預覽失效位置，只有正文指紋、原始來源與唯一新位置皆相符才可修復；確認前重新驗證，內容或索引有變更就略過。
- 無法確認的索引保留供人工處理；修復不搬移或刪除筆記、不更動圖片，也不重建最近儲存清單。Apple 備忘錄僅在手動檢查時列舉貼文。
- 修正封存時可能連帶改寫其他目的地同路徑索引的問題。去重索引依目的地範圍更新，最近儲存與串文參照限於相同 provider。
- 修正重複文章掃描部分讀取失敗時仍覆寫完整去重索引的問題。現在會保留原索引、標記掃描不完整並在 Popup 顯示逐項警告；重開 Popup 後仍可看到原因。

操作方式見 [背景作業與索引修復](INSTALL.md#背景作業與索引修復2180-起)。

## 已執行的驗收

以下檢查均已通過。

| 驗收 | 範圍與結果 |
| --- | --- |
| 語法與套件結構 | 修改的 JS `node --check`、`ruby -c native/host.rb`、extension validator |
| 完整回歸 | `node tests/media-sync.test.mjs`；包含三 provider、去重、圖片、草稿、封存與新索引流程 |
| 修復前失敗重現 | 其他 location 的索引被封存改寫，以及部分掃描覆寫完整索引，皆先 FAIL、修正後 PASS |
| 真實 Helper 隔離流程 | VM background → framed Native Messaging 測試介面 → 真實 Ruby Helper；中文暫存資料夾、`LANG=C`，保存→同文合併→圖片去重→封存→讀回成功，圖片連結完整，第二次封存移動 0 筆 |
| 索引安全性 | Markdown、REST、Notes；切換目的地、預覽後手改、索引變更、多筆相符、缺檔、掃描不完整、寫後讀回與重複確認 |
| Popup 瀏覽器檢查 | ego-browser 載入本機 Popup 與合成 Chrome API；預覽、重新載入恢復、確認修復、延遲回應不覆蓋新目的地、封存失敗顯示，無 JavaScript 錯誤與水平溢出 |

REST／Notes 使用測試替身；Popup 瀏覽器檢查使用合成 Chrome API，並非安裝後的真實 extension runtime。隔離資料夾在測試結束時刪除，未掃描日常 Vault 或操作真實貼文、備忘錄。

重跑自動檢查：

```bash
node --check background.js
node --check popup/popup.js
node --check tests/media-sync.test.mjs
ruby -c native/host.rb
node scripts/validate-extension.mjs
node tests/media-sync.test.mjs
git diff --check
```

## 發布前尚待驗收

1. 在隔離 Chrome profile 載入候選版，確認 Popup、content script、background 都是 2.19.2；重新整理測試用 X／Threads 分頁，再確認擴充功能錯誤頁。
2. 使用測試資料夾驗證真實 Chrome alarm → 安裝版 Helper 的封存，並核對圖片、索引與第二次執行冪等性。
3. 在測試用 Apple 備忘錄資料夾驗證既有同文合併、多圖附件與索引預覽；驗證過程不使用日常資料。
4. 取得測試發文授權後，驗證 X／Threads 真實擷取、跨平台同文、多圖及中途關閉 Popup。
5. 通過後才提交變更並建立新的 `v2.19.2` tag。既有公開 tag 不移動；Release workflow 會依新 tag 執行測試並產出套件。
6. GitHub Release 上傳後，以該 Release 的 `SHA256SUMS` 驗證下載檔。Web Store 使用同一 Release 的 extension ZIP；Helper ZIP 不上傳商店。

## 本機候選套件

本輪已執行 `./scripts/package-extension.sh`，ZIP 完整性與 `shasum -a 256 -c SHA256SUMS` 均通過，產物如下：

- `dist/sun-pit-v2.19.2.zip`
- `dist/sun-pit-helper-v2.19.2-macos.zip`
- `dist/SHA256SUMS`

在 `dist` 執行 `shasum -a 256 -c SHA256SUMS` 檢查這次本機封裝。重新封裝可能因 timestamp 產生不同 hash；本機 checksum 不可當作未來 Release 的驗證結果。
