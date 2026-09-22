<p align="center">
  <img src="icons/logo.svg" width="88" height="88" alt="順筆標誌">
</p>

<h1 align="center">順筆</h1>

<p align="center">
  <strong>繁體中文</strong> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <strong>社群，就是你的筆記本。</strong><br>
  在 X（Twitter）與 Threads 寫下想法，順手記進自己的筆記。
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/sun-pit/jdfempgjnmdlokacfjmnipihhghcnomb"><img alt="Chrome Web Store" src="https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?logo=googlechrome&logoColor=white"></a>
  <a href="https://github.com/lostshin/sun-pit/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/lostshin/sun-pit?style=flat"></a>
  <a href="https://github.com/lostshin/sun-pit/actions/workflows/validate.yml"><img alt="Validate Extension" src="https://github.com/lostshin/sun-pit/actions/workflows/validate.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-6E56B3.svg"></a>
</p>

![順筆工作流程展示](assets/demo.gif)

這段 20 秒展示使用真實的擴充功能 Popup 與隔離範例資料，不含私人帳號內容；另提供高畫質 [MP4](assets/demo.mp4)。

## 直接把社群軟體當成筆記軟體

有時候，打開筆記軟體反而不知道要寫什麼，滑到一則貼文卻能順手寫出一大段想法。既然你原本就習慣在社群上寫，這裡也可以是你的筆記本。

**順筆讓發文和記筆記成為同一件事。** 你在 X（Twitter）或 Threads 寫下自己的想法、接著補充一串回覆，發佈後，文字、串文與靜態圖片就會自動存進你選擇的 Markdown 資料夾、Obsidian 或 Apple 備忘錄，並留下來源與時間。

「順筆」就是順著想法寫，順手記下來。寫的時候留在熟悉的社群介面，日後要找回、整理或延伸，再到自己的筆記裡繼續。不用每次發文後另開一個工具，重新貼上、排版、存檔。

這個專案也來自 AuDHD 的使用需求：切換工具、記得稍後整理，都可能讓剛才的思路斷掉。讓筆記跟著原本的寫作習慣累積，就少一件要提醒自己做的事。

## 你會得到什麼

- 發佈 X 或 Threads 貼文後，自動建立 Markdown 筆記或 Apple 備忘錄。
- 單則貼文、連續串文與靜態圖片都會保存；串文維持原本順序。
- 存成 Markdown 時，每則內容都有獨立、可直接複製的 code block。
- 來源網址、發佈時間、回覆關係、引用貼文與串文數量會一起留下來。
- 撰寫時自動暫存草稿；目的地暫時無法使用時，恢復後會自動補存到原目的地。
- Popup 可預覽、開啟或刪除草稿與最近存檔。
- 沒有第三方 JavaScript、開發者後端、遙測或廣告。

## 支援環境與儲存目的地

| 目的地 | 平台 | 功能與需求 |
| --- | --- | --- |
| 本機 Markdown 資料夾（預設、推薦） | macOS + Google Chrome | 隨附的開源 Native Helper；可選任何可寫資料夾，不需要 `.obsidian`、外掛或 API Key；支援草稿、圖片、三日合併與七日封存 |
| Apple 備忘錄 | macOS + Google Chrome | 使用系統 Notes 自動化；支援正式貼文、圖片、三日合併、開啟、刪除與離線補存；草稿留在 Chrome 本機儲存，不做七日封存 |
| Obsidian Local REST API | macOS、Windows、Linux + Google Chrome | Obsidian 社群外掛 [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) 與 API Key；保留原有功能 |

每次只寫入一個目的地。只有 Local REST API 模式一定需要 [Obsidian](https://obsidian.md/)；一般 Markdown 資料夾與 Apple 備忘錄不需要安裝 Obsidian。本機 Helper 目前只支援 macOS。

## 安裝

順筆的英文識別名是 **sun-pit**。目前工作樹為 2.19.2 候選版；商店與既有 Release 可能仍使用舊名稱及舊套件檔名。完整步驟、更新方式與移除方法請見 [INSTALL.md](INSTALL.md)。以下是最短流程。

### 從 GitHub Release 手動安裝

1. 從 [Releases](https://github.com/lostshin/sun-pit/releases) 下載 `sun-pit-v*.zip` 並解壓縮到固定資料夾。
2. 開啟 `chrome://extensions/` → 啟用「開發人員模式」→「載入未封裝項目」→ 選擇含 `manifest.json` 的資料夾。
3. macOS 使用者若採本機 Helper，在該資料夾執行：

   ```bash
   ./native/install-host.sh
   ```

4. 在 `chrome://extensions/` 重新載入外掛，開啟 Popup，選擇儲存目的地。

Chrome 不能直接載入 ZIP。更新手動安裝版時也要保留相同資料夾位置，否則 extension ID、既有設定與 Helper 授權可能改變。

### 從 Chrome Web Store 安裝

1. 從 [Chrome Web Store](https://chromewebstore.google.com/detail/sun-pit/jdfempgjnmdlokacfjmnipihhghcnomb) 安裝擴充功能。
2. 若要使用預設的本機 Helper，從同版本 [GitHub Release](https://github.com/lostshin/sun-pit/releases) 下載 `sun-pit-helper-v*-macos.zip`。
3. 解壓縮後執行：

```bash
./native/install-host.sh jdfempgjnmdlokacfjmnipihhghcnomb
```

Chrome Web Store 基於安全限制不會自動執行本機安裝程式。Markdown 資料夾與 Apple 備忘錄需要 Helper；若不想安裝，可改用 Local REST API。

## 設定與使用

1. 將擴充功能固定在 Chrome 工具列並開啟 Popup。
2. 本機 Markdown 資料夾：按「選擇資料夾」，可選一般資料夾或 Obsidian Vault 根目錄。
3. Apple 備忘錄：明確選擇帳號與資料夾；`On My Mac` 純本機，iCloud 帳號會由 Apple 同步。
4. Local REST API：輸入 API Key、HTTP port `27123` 或 HTTPS port `27124`，再測試連線。
5. Markdown／REST 模式可調整筆記與圖片路徑；按「儲存設定」。
6. 重新整理已開啟的 X／Threads 分頁，照平常方式撰寫並發佈貼文。

Popup 的「未發佈草稿」與「最近儲存」可顯示內容預覽；開啟與刪除會交給該項目的原儲存目的地，不會刪除社群平台原文。

## 儲存結果

預設筆記路徑是 `個人創作/社群推文`，預設圖片路徑是 `附件/順筆`：

```text
個人創作/社群推文/
└── 2026-07-18_1100_圖片同步測試.md

附件/順筆/
└── 2026-07-18_1100_圖片同步測試/
    ├── image-01.jpg
    └── image-02.webp
```

Markdown 使用可從筆記位置解析的標準相對連結。若個別圖片下載失敗，文字筆記仍會儲存，該圖片則保留遠端網址。

## 權限與資料流

擴充功能只在使用者自己的裝置與選定服務間處理資料：

```text
X／Threads 分頁
  → Chrome extension
  → macOS Native Helper 或 127.0.0.1 Local REST API
  → Markdown 資料夾、Apple 備忘錄或 Obsidian Vault（擇一）
```

- `storage`：保存目的地設定、Apple Notes 模式的完整草稿、離線佇列及最近存檔資訊。
- `nativeMessaging`：在 macOS 與使用者自行安裝的本機 Helper 溝通。
- `notifications`：原始分頁已關閉時回報正式貼文的存檔結果。
- `alarms`：定期補存離線佇列；Markdown 資料夾另執行七日封存維護。
- X／Threads 網站存取：只處理使用者正在撰寫或剛發佈的貼文及相關來源資訊。
- X／Meta 圖片 CDN：下載該貼文中的靜態圖片。
- `127.0.0.1`：只供使用者選擇 Local REST API 模式時連接本機 Obsidian 外掛。
- Apple 備忘錄：只在使用者選擇此目的地時，由 Helper 請求 macOS Automation 權限；選 iCloud 帳號代表內容會依 Apple 設定同步。

專案沒有開發者營運的伺服器，不販售或分享資料，也不執行遠端程式碼。詳情見[隱私權政策](PRIVACY.md)。

## 已知限制

- Native Helper 目前只支援 macOS 與 Google Chrome；Windows、Linux 或其他 Chromium 瀏覽器請使用 Local REST API，或自行貢獻對應安裝支援。
- 目前只同步靜態圖片；影片與動態 GIF 不會下載。
- X 與 Threads 的內部 API 可能改變。回報解析問題時請移除 API Key、cookies、私人貼文與完整平台回應。
- Threads 圖片網址帶有時效簽章；離線過久後可能只能留下遠端網址。
- Apple 備忘錄附件會按順序放在備忘錄末端，不保證嵌入原文位置；不支援原生 tag 與七日封存。
- iCloud 資料夾首次刪除 Markdown 時，macOS 可能要求允許 Ruby／Chrome 控制 Finder；選擇 iCloud Notes 則由 Apple 負責同步。

## Roadmap

專案方向公開記錄在帶有 [`roadmap` label](https://github.com/lostshin/sun-pit/issues?q=state%3Aopen%20label%3Aroadmap) 的 issues，目前探索項目包括：

- [Windows／Linux Native Helper](https://github.com/lostshin/sun-pit/issues/2)
- [Chromium 瀏覽器相容性](https://github.com/lostshin/sun-pit/issues/3)
- [影片與動態 GIF 的本機保存](https://github.com/lostshin/sun-pit/issues/4)
- [Release 套件的瀏覽器層 smoke tests](https://github.com/lostshin/sun-pit/issues/5)
- [Joplin Data API](https://joplinapp.org/help/api/references/rest_api/)：本機 REST、Markdown、CRUD、notebook 與 resource，列為下一個儲存 provider。
- [Bear CLI](https://bear.app/faq/command-line-interface/)：本機 `bearcli` 支援建立、追加、附件與垃圾桶，列為次順位。

Roadmap issues 表示想解決的問題，不代表承諾發布日期；真實工作流程的驗證會優先於功能數量。

## 開發、測試與發布

本專案使用原生 JavaScript、HTML、CSS 與 macOS 系統 Ruby，不需要安裝 npm package。提交前執行：

```bash
node scripts/validate-extension.mjs
node tests/media-sync.test.mjs
./scripts/package-extension.sh
git diff --check
```

打包後 `dist/` 會包含：

- `sun-pit-v<version>.zip`：GitHub 手動安裝與 Chrome Web Store 上傳套件。
- `sun-pit-helper-v<version>-macos.zip`：商店版使用者需要的 macOS Helper。
- `SHA256SUMS`：兩個 ZIP 的 SHA-256 checksum。

貢獻方式見 [CONTRIBUTING.md](CONTRIBUTING.md)，Chrome Web Store 欄位、權限理由與審查步驟見 [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md)。

## 回報與授權

- Bug 與功能建議：[GitHub Issues](https://github.com/lostshin/sun-pit/issues)
- 安全漏洞：[SECURITY.md](SECURITY.md)
- 授權：[MIT License](LICENSE)

本專案是獨立開源工具，未受 X、Meta、Threads、Obsidian 或其關係企業贊助、認可或維護。

如果你也習慣在社群上寫下想法，歡迎試試順筆，直接把平常發的文累積成自己的筆記。
