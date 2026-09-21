# 順筆 sun-pit：商店文案（2.19.1 候選版）

本頁是目前品牌與商店文案的來源；`publish-v2.4.0/`、`publish-v2.4.2/` 保留歷史版本紀錄。此文案尚未代表 Chrome Web Store 已核准或更新。

## 商品識別

- 名稱：`順筆 sun-pit`
- 簡稱：`順筆`
- Extension ID：`jdfempgjnmdlokacfjmnipihhghcnomb`（沿用既有項目）
- 版本：`2.19.1`
- 主要語言：繁體中文
- GitHub：`https://github.com/lostshin/sun-pit`
- 支援：`https://github.com/lostshin/sun-pit/issues`
- 隱私權政策：`https://github.com/lostshin/sun-pit/blob/main/PRIVACY.md`

## 繁體中文

### 摘要

```text
社群，就是你的筆記本。在 X 與 Threads 寫下想法，發文後自動記進 Markdown 資料夾、Obsidian 或 Apple 備忘錄。
```

### 詳細說明

```text
順筆 sun-pit｜社群，就是你的筆記本。

有時候，打開筆記軟體反而不知道要寫什麼，滑到一則貼文卻能順手寫出一大段想法。順筆讓發文和記筆記成為同一件事：你照常在 X（Twitter）或 Threads 寫下自己的想法，發佈後，文字、串文與靜態圖片就會自動存成筆記。

「順筆」就是順著想法寫，順手記下來。寫的時候留在熟悉的社群介面，日後要找回、整理或延伸，再到自己的筆記裡繼續。這個專案也來自 AuDHD 的使用需求，希望少一點切換工具，少一件要提醒自己做的事。

選擇你的筆記放哪裡：
• 本機 Markdown 資料夾：macOS 可選任何可寫資料夾，也可以是 Obsidian Vault。
• Apple 備忘錄：macOS 透過系統自動化儲存；iCloud 帳號會依 Apple 設定同步。
• Obsidian Local REST API：適用 macOS、Windows、Linux，需要 Obsidian 外掛與 API Key。
每次只寫入一個目前目的地。

日常使用：
• 保存自己的貼文、串文與靜態圖片，保留來源、時間、引用與回覆資訊。
• 撰寫時自動暫存，目的地暫時無法連線時保留佇列並重試。
• Popup 可預覽、開啟或刪除草稿與最近筆記；不會刪除社群上的原文。
• 跨平台同文可合併；既有重複文章先預覽，確認後才合併。
• Markdown／REST 支援七日封存，Popup 顯示背景作業結果。
• 索引檢查先列出失效位置，確認後只修復能唯一比對的項目。

macOS 的 Markdown 資料夾與 Apple 備忘錄需要另行安裝開源 Native Helper。Chrome Web Store 不會代裝 Helper，請從同版本 GitHub Release 下載並依 INSTALL.md 安裝。需重新安裝 Helper 1.10.0。

沒有開發者後端、遙測、分析或廣告。文字與設定在自己的裝置及所選目的地間處理；圖片由原平台 CDN 下載。影片與動態 GIF 不會下載。

順筆沿用同一個商店項目。它是獨立開源工具，未受 X、Meta、Threads、Obsidian 或其關係企業贊助、認可或維護。
```

## English

### Summary

```text
Your social feed is your notebook. Turn your X and Threads posts into notes in Markdown, Obsidian, or Apple Notes.
```

### Description

```text
sun-pit · 順筆 — Your social feed is your notebook.

A blank notebook can leave you wondering what to write, while a post in your feed brings a whole idea to mind. sun-pit makes posting and taking notes the same action. Write your own thoughts on X or Threads; after you publish, the text, thread, and static images become notes in your chosen destination.

The name 順筆 means writing as your thoughts come and keeping a note along the way. Stay in the social app while you write, then return to your notes to find or develop an idea. The project grew out of AuDHD needs: less tool-switching and one fewer task to remember.

Choose one destination:
• A local Markdown folder on macOS, including an Obsidian Vault if you use one.
• Apple Notes on macOS, using the system automation interface. iCloud accounts follow Apple's sync settings.
• Obsidian Local REST API on macOS, Windows, or Linux, with the plugin and an API key.

Posts keep their source, time, thread, reply context, quotes, and static images. Drafts save automatically, connection failures stay in a retry queue, and the popup lets you preview, open, or delete saved notes. Deleting a note does not delete the original social post.

Cross-platform copies can become one note. Existing duplicates require a preview and confirmation before merging. Markdown and REST destinations support seven-day archiving; the popup shows the outcome. Index checks preview obsolete references and repair only uniquely verified matches after confirmation.

Local Markdown and Apple Notes require the open-source macOS Native Helper, installed separately from the matching GitHub Release. The Chrome Web Store cannot install it for you. Reinstall Helper 1.10.0 for the new Native Host name. Obsidian REST is the alternative for other operating systems.

No developer backend, telemetry, analytics, or advertising. Images come from the original platform's CDN. Videos and animated GIFs are not downloaded.

sun-pit uses the same store item. This independent open-source project is not sponsored, endorsed, or maintained by X, Meta, Threads, Obsidian, or their affiliates.
```

英文文案供需要時使用；目前 manifest 使用單一雙語名稱，未加入 `_locales`。

## 單一用途

```text
讓使用者直接把 X 與 Threads 當成筆記軟體：將自己撰寫與發佈的內容存成筆記，寫入使用者選定的 Markdown 資料夾、Obsidian 或 Apple 備忘錄。
```

## 素材

| 素材 | 檔案 |
| --- | --- |
| Icon | `../../icons/icon128.png` |
| 工作流程 1280×800 | `screenshot-overview.png` |
| Small promo 440×280 | `small-promo.png` |
| Popup 展示 1280×800 | `popup-ui.png` |
| 社群預覽 1280×640 | `../social-preview.png` |

Popup 展示使用真實介面 HTML 與合成資料，不包含私人筆記。發布前仍須以安裝後的擴充功能完成實機驗收。
