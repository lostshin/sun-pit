# 順筆：安裝、更新與移除

順筆 每次寫入一個儲存目的地：

| 目的地 | 適用環境 | 額外需求 |
| --- | --- | --- |
| 本機 Markdown 資料夾（推薦） | macOS + Google Chrome | 安裝隨附的開源 Native Helper；可選一般資料夾或 Obsidian Vault |
| Apple 備忘錄 | macOS + Google Chrome | 安裝同一個 Native Helper，並允許 macOS Automation 權限 |
| Obsidian Local REST API | macOS、Windows、Linux + Google Chrome | Obsidian 社群外掛 [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) 與 API Key |

只有 Local REST API 目的地一定要安裝 [Obsidian](https://obsidian.md/)。Native Helper 目前只提供 macOS 版本，並使用系統內建的 `/bin/zsh` 與 `/usr/bin/ruby`。

## 從 GitHub Release 手動安裝

1. 從 [GitHub Releases](https://github.com/lostshin/sun-pit/releases) 下載 `sun-pit-v*.zip`。
2. 解壓縮到不會隨意移動的固定資料夾。Chrome 會以資料夾位置識別未封裝擴充功能。
3. 開啟 `chrome://extensions/`，啟用「開發人員模式」，按「載入未封裝項目」，選擇含有 `manifest.json` 的資料夾。
4. macOS 使用者若採本機 Helper，在終端機進入該資料夾後執行：

   ```bash
   ./native/install-host.sh
   ```

5. 回到 `chrome://extensions/` 按此外掛的「重新載入」。
6. 開啟 Popup，選擇目的地：

   - 本機 Markdown 資料夾：按「選擇資料夾」，可選任何可寫資料夾，不要求 `.obsidian`。
   - Apple 備忘錄：選擇帳號與資料夾；`On My Mac` 純本機，iCloud 帳號會由 Apple 同步。
   - Local REST API：填入 API Key 與 port（HTTP `27123` 或 HTTPS `27124`）。

7. macOS 首次要求資料夾、Finder 或 Apple 備忘錄 Automation 權限時，確認目標正確後按「允許」。

## 從 Chrome Web Store 安裝

Chrome Web Store 只能安裝擴充功能，不能代替使用者安裝 Native Helper。商店版使用者若採本機 Helper，需要再完成以下步驟：

1. 從 [Chrome Web Store](https://chromewebstore.google.com/detail/sun-pit/jdfempgjnmdlokacfjmnipihhghcnomb) 安裝順筆。
2. 從同版本的 [GitHub Release](https://github.com/lostshin/sun-pit/releases) 下載 `sun-pit-helper-v*-macos.zip` 並解壓縮。
3. 在終端機進入 Helper 解壓縮資料夾，使用正式 extension ID 執行：

   ```bash
   ./native/install-host.sh jdfempgjnmdlokacfjmnipihhghcnomb
   ```

4. 回到 `chrome://extensions/` 按「重新載入」，再依上一節第 6–7 步選擇目的地。

若不想安裝 Helper，可在 Popup 選擇「Obsidian Local REST API」，填入 API Key 與 port，再測試並儲存設定。

## 開始使用

1. 重新整理已開啟的 `x.com` 或 `threads.com` 分頁。
2. 照平常方式撰寫並發佈貼文。
3. Popup 會顯示未發佈草稿、最近五筆存檔與待補存數量；開啟與刪除會交給項目的原目的地。
4. Markdown／REST 的筆記預設寫入 `個人創作/社群推文`，圖片預設寫入 `附件/順筆`；Apple 備忘錄不使用這兩個路徑。

## 背景作業與索引修復（2.18.0 起）

Popup 的「背景作業」顯示目前已生效目的地的最近封存結果、失敗原因與下次預定時間。待補存數量仍顯示在上方，並標示建立佇列時的原目的地。Apple 備忘錄不執行七日封存。

若曾手動搬移筆記，或直接透過 Helper 封存，索引可能仍指向舊位置：

1. 確認 Popup 顯示的「目前已生效」目的地正確；切換目的地後要先儲存設定。
2. 按「檢查目前目的地」。這會讀取該目的地的貼文並顯示舊位置、新位置與需人工確認的項目，不修改筆記或索引。Apple 備忘錄只有按下按鈕才會列舉貼文。
3. 核對預覽後按「確認修復索引」。只有正文指紋與原始來源相符、且新位置唯一的項目才會更新。檢查後內容或索引有變更的項目會略過；找不到或多筆相符的項目會保留。
4. 再按一次「檢查目前目的地」，確認剩餘項目。檢查結果保存在本機，關閉 Popup 再開啟仍可查看。

此功能只修復已存在的內容去重索引，不會搬移或刪除筆記，也不會修復圖片連結或重建「最近儲存」。封存失敗時先依顯示原因恢復 Helper／REST 連線；若沒有排程時間，可儲存設定重新建立排程。

2.19.1 需要 Native Helper **1.10.0 以上**。請重新執行新版 Helper 安裝程式，再選擇 Markdown 根資料夾。

## 更新

順筆（sun-pit）更新時需重新安裝 Helper。更新時請保留原本的 unpacked 資料夾位置，或沿用同一個商店項目，讓 Chrome 保留既有設定與佇列。Chrome extension ID 保留；Native Host ID 改為 `com.lostshin.sun_pit`，Helper 設定目錄改為 `~/Library/Application Support/sun-pit`；不要移除擴充功能再重裝。

新安裝預設圖片路徑為 `附件/順筆`；已儲存的圖片路徑仍沿用原設定，舊附件不會搬移。

- Chrome Web Store 版會自動更新擴充功能；若 Release notes 指出 Helper 有更新，請下載新版 Helper ZIP 並用相同 extension ID 重新執行安裝程式。
- GitHub 手動安裝版請保留原資料夾位置、用新版內容覆蓋後按「重新載入」。若改用不同資料夾，Chrome 可能產生不同 extension ID，原設定與 Helper 授權也不會自動轉移。
- 重新載入擴充功能後，務必重新整理已開啟的 X／Threads 分頁。

## 移除

1. 在 `chrome://extensions/` 移除擴充功能；這會清除該 Chrome profile 的設定、本機 Notes 草稿與離線佇列，不會刪除既有 Markdown、Obsidian 或 Apple 備忘錄內容。
2. macOS 使用者可在 Helper 解壓縮資料夾執行：

   ```bash
   ./native/uninstall-host.sh
   ```

   此指令會移除 Helper 與 Native Messaging manifest，但保留資料夾選擇設定。若也要清除 Helper 設定，使用 `./native/uninstall-host.sh --purge`。

遇到問題時請先查看 [README 的已知限制](README.md#已知限制)，再到 [GitHub Issues](https://github.com/lostshin/sun-pit/issues) 回報；不要貼出 API Key、私人貼文或完整平台回應。
