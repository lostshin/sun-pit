# Chrome Web Store 上架資料（v2.4.0）

## 商品識別

- Extension ID：`jdfempgjnmdlokacfjmnpiphhghcnomb`
- 套件標題：`順筆`
- 建議不要更名：目前名稱簡短、英文自然度可接受，並保留 repository、Popup、Helper 與使用者文件的一致品牌。中文搜尋意圖放進摘要與說明即可。
- 套件摘要（由 `manifest.json` 帶入）：`發佈 X 與 Threads 貼文後，自動將文字與圖片備份至你的 Obsidian Vault`
- 類別：`生產力工具（Productivity）`
- 語言：`中文（繁體）`

## 商店說明

```text
把發出去的貼文，留在自己手上。

順筆 會在你於 X 或 Threads 發佈貼文後，自動把文字、串文與靜態圖片整理成 Markdown，寫入你指定的 Obsidian Vault。不必再手動複製貼上，也不必把內容交給另一個雲端筆記服務。

你會得到：
• 清楚的 YAML frontmatter：包含標題、平台、發佈時間、來源網址與串文數量
• 可直接複製的內容：每一則貼文或串文都以 Markdown code block 保存
• 完整的串文結構：X 與 Threads 的連續貼文會依原順序整理
• 自動圖片歸檔：靜態圖片下載到自訂附件路徑，筆記使用相對連結
• 自動草稿：撰寫時暫存，正式發佈並成功存檔後才清除
• 失敗補存：Obsidian 暫時無法使用時保留佇列，恢復後自動重試
• Popup 管理：預覽、開啟、刪除草稿與最近五筆存檔

本機優先

macOS 使用者可安裝開源 Native Helper，直接把 Markdown 與圖片寫進自己的 Vault，不需要 Obsidian 外掛或 API Key。Chrome Web Store 不會自動安裝本機程式；請從同版本 GitHub Release 另行下載 Helper，並依安裝說明完成設定。

Windows、Linux，或不想安裝 Helper 的使用者，可改用 Obsidian Local REST API 模式。

隱私與資料控制

所有文字與設定都在使用者自己的裝置上處理。本專案沒有開發者後端、遙測、分析或廣告，也不會載入遠端程式碼。圖片只會從原社群平台的 CDN 下載，再寫入使用者自己的 Vault。

目前支援靜態圖片；影片與動態 GIF 不會下載。

本專案是獨立開源工具，未受 X、Meta、Threads、Obsidian 或其關係企業贊助、認可或維護。
```

## 圖片上傳順序

1. 商店圖示：`../../../icons/icon128.png`
2. 截圖 1：`01-popup.png`（真實 Popup UI 與核心價值）
3. 截圖 2：`02-markdown.png`（YAML、Markdown、串文與 code block）
4. 截圖 3：`03-workflow.png`（X／Threads → 本機處理 → Vault）
5. 小型宣傳圖片：`small-promo.png`
6. Marquee 宣傳圖片：`marquee-promo.png`（選填，但已備妥）
7. 宣傳影片：留白

## URL

- 官方網址：留白；只有完成 Search Console 網域驗證後才能選。
- 首頁：`https://github.com/lostshin/sun-pit`
- 支援：`https://github.com/lostshin/sun-pit/issues`
- 隱私權政策：`https://github.com/lostshin/sun-pit/blob/main/PRIVACY.md`

## 隱私權：單一用途

```text
將使用者自己在 X 或 Threads 撰寫與發佈的貼文文字、來源資訊與靜態圖片，備份至使用者指定的本機 Obsidian Vault。
```

## 隱私權：權限理由

### storage

```text
在目前 Chrome profile 保存寫入模式、Vault 顯示名稱、相對路徑、選用的 REST API 設定、最多 50 則離線佇列、草稿狀態與最近五筆存檔資訊。這些資料只用於備份、補存與顯示使用者可見的存檔狀態。
```

### nativeMessaging

```text
在 macOS 與使用者自行安裝的開源 Native Helper 通訊，將 Markdown 與靜態圖片直接寫入使用者選定的 Obsidian Vault。Native Host 只接受這個 Chrome Web Store extension ID，並拒絕 Vault 外或 symbolic link 路徑。
```

### notifications

```text
只有在原始 X／Threads 分頁已不存在時，才以系統通知回報正式貼文存檔或離線補存結果。草稿成功不會產生系統通知。
```

### alarms

```text
每分鐘嘗試補存離線佇列，並觸發必要的 best-effort Vault 維護。這項權限不用於追蹤使用時間或一般瀏覽活動。
```

### 主機權限

```text
twitter.com、x.com 與 threads.com 用於偵測使用者自己的撰寫與發佈動作，並從該次發佈回應取得文字、來源網址與媒體資訊。127.0.0.1:27123 與 127.0.0.1:27124 只在使用者選擇 Local REST API 模式時連接同一台裝置上的 Obsidian 外掛。pbs.twimg.com、cdninstagram.com 與 fbcdn.net 只用於下載使用者剛發佈貼文中的靜態圖片。
```

### 遠端程式碼

- 選擇：`否，我沒有使用遠端程式碼。`

```text
所有 JavaScript 都包含在提交的 extension ZIP 中；本擴充功能不使用 eval()、new Function() 或外部 script。X／Meta API 回應與圖片 CDN 內容只作為資料處理，不會被當成程式碼執行。Native Helper 是使用者明確下載安裝的開源本機 companion，透過 Chrome Native Messaging API 通訊。
```

## 隱私權：資料類型

保守勾選：

- `Personally identifiable information`：來源或引用資訊可能包含使用者名稱與顯示名稱。
- `Authentication information`：只有 REST 模式會處理使用者輸入的本機 API Key。
- `Website content`：草稿、貼文、串文、引用文字、來源網址、靜態圖片與替代文字。

不要勾選金融、健康、精確位置、完整瀏覽紀錄、cookies 或密碼。若 Dashboard 將公開貼文歸在 `User-generated content`，也應勾選並沿用 Website content 的說明。

資料用途只勾核心功能所需項目。確認下列 Limited Use 聲明：

- 資料只用於提供或改善這項單一備份功能。
- 不販售資料，不用於個人化廣告或信用評估。
- 不轉移給與單一用途無關的第三方。
- 不允許人員讀取；法律、安全或使用者明確授權的個案除外。

## 發布

- 付款：`免費`
- 應用程式內購：`無`
- 顯示設定：`公開`
- 地區：`所有地區`
- 自動發布：送審時取消勾選，採 `Deferred publishing`；審核通過後再手動發布。

## 測試操作說明

- 測試帳號：`不需要開發者提供帳號或密碼`
- 其他要求：Reviewer 可使用自己的 X／Threads 測試帳號。

```text
This extension has one purpose: back up the reviewer's own X or Threads posts to a user-selected local Obsidian Vault.

Recommended macOS test path:
1. Download the matching macOS helper ZIP from the GitHub Release linked in the listing.
2. Run: ./native/install-host.sh jdfempgjnmdlokacfjmnpiphhghcnomb
3. Reload the extension, open the popup, choose a folder containing .obsidian, and save settings.
4. Open X or Threads, compose a test post, and verify the generated Markdown in the selected Vault.

Alternative test path on any OS:
1. Install the Obsidian Local REST API community plugin.
2. Select Local REST API in the popup and enter the local API key and port.

No developer-operated server, paid account, analytics service, or remote code is used. The extension does not provide or collect X/Threads credentials; reviewers may use their own test account. Native Helper source is included under native/ and in the public repository.
```

## 送審前不可略過

1. 建立公開 GitHub `v2.4.0` Release，附 extension ZIP、Helper ZIP 與 `SHA256SUMS`。
2. 用正式 ID `jdfempgjnmdlokacfjmnpiphhghcnomb` 驗證 Helper。
3. 在隔離資料下完成 Popup、X 單則／串文、Threads 單則／串文、刪除與補存驗收。
4. 確認開發者聯絡信箱、兩步驟驗證與隱私權政策 URL 可用。
5. 全部欄位儲存後，點「為何無法提交？」檢查是否仍缺必填項。
