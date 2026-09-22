# Chrome Web Store 上架文案（v2.4.2）

本版沿用 `順筆` 名稱、Productivity 類別、既有圖片素材、權限理由與 Privacy practices。只更新繁中／英文商店文案與 extension package；`v2.4.2` 沒有新增 Chrome 權限，也沒有修改 Native Helper。

## 商品識別

- Extension ID：`jdfempgjnmdlokacfjmnpiphhghcnomb`
- Name：`順筆`
- Version：`2.4.2`
- Category：`Tools`（既有已發布項目鎖定，Dashboard 不允許改為 Productivity）
- Primary language：`中文（繁體）`
- Secondary locale：`v2.4.2` 未提供；下方英文文案保留給加入 `_locales` 的後續版本
- Visibility：`Public`
- Regions：`All regions`

## 中文（繁體，主要語系）

### 摘要（後續 localized package）

```text
直接把 X（Twitter）與 Threads 當成筆記軟體。貼文、串文與靜態圖片會自動存進 Obsidian，不用複製貼上，也不用按擷取按鈕；特別適合想減少工具切換與寫作阻力的 AuDHD 族群。
```

`v2.4.2` 的 Name／Summary 由 `manifest.json` 提供，Dashboard 唯讀；本版仍顯示 manifest 內的既有摘要。要套用上方摘要與英文副語系，必須在後續版本加入 `_locales` 並上傳新套件。

### 詳細說明

```text
直接把社群媒體當成你的筆記軟體。

你已經在 X（Twitter）或 Threads 寫下想法，為什麼發文後還要再整理一次？

順筆 會在貼文發佈後，自動把文字、串文與靜態圖片整理成 Markdown，存進你自己的 Obsidian Vault。短短一句會存，一路寫下去的長串文也會存，而且保留原本順序。

寫完就存，不用回頭

發文後，不必回頭按擷取、不必切到 Obsidian，也不必重新整理格式。你照原本的方式寫，筆記會自己存好。

長串文也不會散掉

每一則串文都會依序保存，並放進獨立、可直接複製的 Markdown code block。來源網址、發佈時間、平台、回覆、引用與串文數量也會一起留下來。日後回到 Obsidian，看到的是完整文章，不是一堆散落的貼文。

少一次切換，留住原本的思路

寫作阻力常常出現在寫完之後：切到另一個工具、按下擷取、調整格式，再確認有沒有存好。對 AuDHD 族群而言，這些額外步驟更可能打斷思路，也容易讓「等等再整理」最後變成沒有整理。

順筆 把保存工作放到背景。社群平台負責讓你開始寫，Obsidian 負責讓內容留下來。你不用另外養成一套筆記習慣，也少了一個中斷寫作的地方。

不用多做，筆記照樣完整

• 發佈 X 或 Threads 貼文後，自動建立 Markdown 筆記
• 保存單則貼文、連續串文與靜態圖片
• 自動暫存草稿，正式貼文成功存檔後才清除
• Obsidian 暫時無法使用時先排入佇列，恢復後自動補存
• 自訂筆記與附件路徑
• 從 Popup 預覽、開啟或刪除草稿與最近存檔

內容回到自己的 Vault

macOS 使用者可安裝開源 Native Helper，直接寫入自己的 Vault，不需要 Obsidian 外掛或 API Key。Windows、Linux，或不想安裝 Helper 的使用者，可以改用 Obsidian Local REST API。

本專案沒有開發者後端、遙測、分析或廣告，也不會載入遠端程式碼。文字、圖片與設定只在你的裝置上處理。

目前支援靜態圖片；影片與動態 GIF 不會下載。

本專案是獨立開源工具，未受 X、Meta、Threads、Obsidian 或其關係企業贊助、認可或維護。
```

## English（後續 localized package）

### Summary

```text
Turn X and Threads into your writing inbox. Posts and threads save to Obsidian automatically—no copy-paste or capture button.
```

### Detailed description

```text
Write where you already write.

You are already capturing ideas on X or Threads. Why do the same work again after you publish?

順筆 automatically turns published posts, threads, and static images into Markdown in your own Obsidian Vault. A single thought is saved. A long thread is saved in its original order.

Publish once. Keep it in Obsidian.

There is no capture button to remember, no copy-paste trip back to Obsidian, and no second round of formatting. Keep writing the way you already do. The note takes care of itself.

Threads stay together

Each post in a thread is preserved in order and kept in its own copyable Markdown code block. Source URLs, publish times, replies, quotes, and thread counts stay with the writing. When you return to Obsidian, you get the complete piece instead of scattered posts.

Less context switching, less writing friction

Writing flow often breaks after the writing is done: switching tools, pressing a capture button, fixing the format, and checking whether the note was saved. For people in the AuDHD community, those extra steps can make “I’ll organize it later” turn into never organizing it.

順筆 handles the filing in the background. Social media is where the writing starts; Obsidian is where it stays. There is no second note-taking habit to build.

Do less. Keep the complete note.

• Create Markdown automatically after publishing on X or Threads
• Preserve individual posts, multi-post threads, and static images
• Autosave drafts and clear them only after the published post is safely stored
• Queue interrupted saves and retry when Obsidian becomes available again
• Choose your own note and attachment paths
• Preview, open, or delete drafts and recent saves from the popup

Your writing stays in your Vault

On macOS, the open-source Native Helper writes directly to your Vault without an Obsidian plugin or API key. Windows and Linux users—or anyone who prefers not to install the Helper—can use the Obsidian Local REST API instead.

There is no developer-operated backend, telemetry, analytics, advertising, or remote code. Your writing, images, and settings are processed only on your own device.

Static images are supported. Videos and animated GIFs are not downloaded.

This is an independent open-source project and is not sponsored, endorsed, or maintained by X, Meta, Threads, Obsidian, or their affiliates.
```

## v2.4.2 審查補充

### Reviewer note

```text
v2.4.2 updates Threads media capture for current endpoints: configure_text_only_post, configure_text_post_app_feed, and configure_text_post_app_sidecar. It accepts permalink-based responses and selects the largest static image. No permissions, data practices, Helper, or remote code changed.

macOS test: get the Helper from the GitHub Release; run ./native/install-host.sh jdfempgjnmdlokacfjmnpiphhghcnomb; choose a Vault in the popup; publish on X or Threads; verify the Markdown.
```

Dashboard 實測上限為 500 字元；以上內容共 482 字元，已於 2026-07-23 儲存。

## Dashboard 狀態（2026-07-23）

- Published package：`v2.4.0`
- Draft package：`v2.4.2`
- Submission：`待審查`
- Publishing：審查通過後自動發布
- Anonymous delivery：公開頁仍導向 `empty-title`，update service 仍回 `error-unknownApplication`

## 上傳資料

- Extension ZIP：GitHub Release `v2.4.2` 的 `sun-pit-v2.4.2.zip`
- Helper ZIP：只放 GitHub Release，不上傳 Chrome Web Store
- 圖片素材：沿用 `assets/store/publish-v2.4.0/`
- Permission justifications：沿用 `assets/store/publish-v2.4.0/LISTING.md`
- Privacy practices：沿用 `assets/store/publish-v2.4.0/LISTING.md`
