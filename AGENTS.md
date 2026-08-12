<!-- 本檔是本專案唯一規則檔;CLAUDE.md 是指向本檔的 symlink。
     裁減／最佳化時只刪過期或重複內容,不得刪除任一工具專屬規則。 -->

# AGENTS.md

本檔供 Claude Code 與 Codex 共用，記錄目前架構、不可回退的產品契約、已驗證陷阱與最短驗收路徑。硬上限 200 行；現況以 `manifest.json`、`native/host.rb`、程式與測試為準，新增經驗時先取代過時內容，不要重抄。

## 開工、修改與交付

1. 先跑 `git status --short`；既有 dirty files 屬於使用者。只碰任務檔，不順手重構、格式化、stage 或發布。
2. 用 `rg -n` 追函式、訊息與測試，不先掃完整 repository。回歸優先擴充 `tests/media-sync.test.mjs` 的 VM、假 Native Host／`osascript`、YAML 與隔離資料夾 harness。
3. 修 bug 必須先新增可重現測試並確認 FAIL，再修到 PASS；靜態 source assertion 只能保護 UI 接線，資料與流程應以可執行測試驗證。
4. 大段重寫前確認檔案可由 git 回復；dirty 檔先同目錄備份。每個 changed line 都要能追溯到使用者需求。
5. 不操作日常 Chrome profile、真實貼文、真實 Notes／Vault，除非使用者明確授權。社群代發目前暫停。
6. 只有發布任務才跑 `./scripts/package-extension.sh`；公開 tag 不移動、不刪除、不重打。

## 專案定位與架構

- Chrome Manifest V3 擴充功能；把 X／Threads 貼文與圖片寫到單一目的地：本機 Markdown 資料夾、Obsidian Local REST API 或 Apple 備忘錄。無 build step、無第三方 runtime 依賴。
- MAIN world `content/interceptor.js` 攔 fetch／XHR；isolated world `content/common.js` + 平台檔擷取 DOM；`background.js` 管 provider、草稿、queue、recent refs、合併與 alarm；`popup/*` 只透過 background 操作目的地。
- `shared/settings.js` 與 `providers/*.js` 是 background／popup 的共用設定與 adapter registry。新增或改名共用檔時同步更新 validator 與 package 必含清單。
- 中立模型是 `SocialPostData`；工作流不得依賴 Markdown path。`StorageRef` 是 file ref 或 Notes `{provider,noteId,title,externalKey}`；開啟、刪除、exists 一律交給 ref 所屬 provider。
- 每次只寫一個目前目的地，但 queue 綁建立時的原 provider；切換後仍回原目的地補存，不複製 API Key。

## 版本、重載與驗證（硬規則）

- Extension 版本真相是 `manifest.json.version`；程式行為 bug fix bump patch、可見新功能 bump minor。Host 行為另 bump `HOST_VERSION`，並同步提高 `MIN_NATIVE_HOST_VERSION`，避免新版流程搭配舊 Host。
- Host 修改後執行 installer，並以 checksum／`cmp` 讀回確認安裝檔等於 `native/host.rb`。Web Store 不會代裝 Helper。
- 每次程式改動依序跑：改過的 JS `node --check`、Host `ruby -c`、`node scripts/validate-extension.mjs`、`node tests/media-sync.test.mjs`、`git diff --check`。
- Runtime 驗收固定：`chrome://extensions` 重新載入 → 重新整理所有 X／Threads 分頁 → 確認 popup／content／background 顯示同版號 → 清空後重看擴充功能錯誤頁。
- `Extension context invalidated` 通常是舊 content script；只按「重新載入」，不要移除再重加（會清掉 `chrome.storage.local`）。錯誤頁行號可能套在新檔上，先比版本與時間戳。
- 自動測試／validator／toast 不等於真實 E2E；未實測的 Notes、X／Threads、多圖或 Vault 行為必須明說。

## Provider、設定 migration 與 Popup 隔離

- `storageSchemaVersion` migration 是「不批次遷移資料」的唯一例外：先轉設定、refs、thread contexts、drafts 與 queue，寫入後 read-back 深度驗證成功才刪舊 keys；失敗時保留舊資料並停止寫入。正常路徑不得保留舊 schema fallback。
- 「Unknown native host action」先查原始碼 Host 版本、安裝檔版本與 manifest allowed origin；不要先改 background action 名。Host 每次 native message 都是新程序，不依賴 request 間記憶體。
- Popup 初次開啟不得同步列舉 Notes 或逐筆 exists；Notes locations 用本機 cache、只有進入／重新載入 Apple 面板才更新，自動 activity sync 帶 `skipAppleNotes: true`。
- Provider selector 改變時立即清掉前一 provider 的 form／action error，連線卡顯示「儲存後生效」。所有非同步檢查帶 request generation；舊 provider 晚回來的 response 不得覆寫新狀態。
- `recentSaves` 在 storage 保留跨 provider refs，但 Popup「最近儲存」只顯示目前已生效 provider；storageProvider 改變後重繪。Queue UI 必須標成「原目的地」，不得冒充目前目的地錯誤。
- Apple queue 失敗只保留 queue；Markdown 模式的連線狀態只反映 Markdown Helper，不得自動驗證 Apple 身分。

## Apple 備忘錄契約與已驗證陷阱

- Notes 只透過 scripting dictionary 與 Native Helper；不碰私有 SQLite。所有正文／附件經 `0600` temp file 傳入，不把使用者內容插值進 AppleScript，ensure 清除暫存檔。
- Native stdout 只能是 4-byte little-endian 長度 + UTF-8 JSON；子程序 stdout／stderr 必須捕捉並用 UTF-8 解碼。`LANG=C`／`LC_ALL=C` 仍要通過 Unicode 測試，避免 `invalid byte sequence in US-ASCII`。
- Apple Notes 會正規化 HTML 並移除 `data-sp2o-key`；它只能當 legacy fast path，不能是唯一身分證明。`find/read/upsert/show/delete/exists` 必須退回精確比對「來源：」區塊內的 X status ID／Threads post code。
- 刪除／更新前先讀回驗證，執行動作時再以剛找到的精確 marker 重查，避免 note ID 指錯或貼文 ID 前綴誤判；真正不符仍回 `NOTES_IDENTITY_MISMATCH`，不可為了好刪而直接信任 note ID。
- 正文所有使用者／引用文字 HTML escape。來源、回覆、引用、平台與原始時間放正文；Notes creation／modification date 唯讀。
- 三日自回覆以 note ID 讀回目前 HTML 後追加，保留手改；母筆記不存在、鎖定或身分不符時另建並標示母筆記，不得丟回覆。附件重試只替換同名 `image-NN.ext`。
- Apple 模式草稿完整快照只存 `draftSnapshot_x/threads`；正式貼文被目的地接受後才清。Notes 不支援七日封存。
- Automation denied、Notes 未啟動、location 刪除、locked、not found、identity mismatch 必須保留不同 error code；測試用假 `osascript`，不碰真實 Notes。

## 發布、草稿與自回覆共同契約

- API 回應優先，DOM 只做擷取與 8 秒備援；備援後保留 `fallbackBase`，遲到 API 以原 timestamp 覆寫同一 ref。串文後續 API 回應在 15 秒窗忽略，但判斷排在遲到修正之後。
- 點擊與 `Cmd/Ctrl+Enter` 都觸發。正式流程固定：先存正式內容 → 成功才刪目的地草稿 → 才清 `draftStatus_*`；失敗保留草稿。`lastPublishTimestamp` 只在已接受或進 queue 後設定。
- Background 每平台用 `taskChains` 序列化。Host／REST 網路不可用才進 queue；Host 已回應的設定／路徑錯誤與 REST 4xx/5xx 不進 queue。
- 草稿成功只顯示低調常駐狀態，不發系統通知；正式成功用頁面 toast，原分頁不存在才退系統通知。
- `draftStatus_*`、`recentSaves`、`recentThreadContexts` 是不同資料。Recent 依 `StorageRef` 去重並保留 5 筆；thread context 三日、上限 100。
- 檔名 `YYYY-MM-DD_HHmm_摘要.md`；空摘要退回 `貼文`。字數裁切用 code point，不切斷 emoji；平台名稱走 `platformDisplayName()`，檔名 `Twitter`、metadata `Twitter/X`。
- `data.replyTo` 是唯一合併入口；抓不到回 `null`，不可拿 dialog 外頁面網址猜。X API 用 `in_reply_to_status_id_str`；Threads create response 無 replyTo，靠 composer scope 的 DOM 備援。
- 找母筆記依序：`recentThreadContexts` → `recentSaves` → provider source index。Markdown 母筆記優先讀回原文追加以保留手改；錨點不符就另存並帶 `thread_root`，另存前清母筆記 merge metadata。

## X／Threads 擷取與補存

- X 真 editor 固定 `[data-testid^="tweetTextarea_"][contenteditable="true"]`；按 editor `data-testid` 去重，不按文字。500ms draft debounce 只在共用 pipeline。
- X 發布後 DOM 會重建；content 與 background 都保留 2 秒 session guard，background 以 tabId + storage 跨 worker restart，不得誤擋其他分頁／新 composer。
- Threads inline 回覆沒有 dialog；`source` 必須一路傳給內容、引用與 draft input，往上找同時含 editor 與精確 Post／Reply／發佈／發布／回覆按鈕的最小 composer，搜尋在 main/navigation/body 前停止。
- 無 `pendingPost`、非 fallback 遲到修正的 create response 只記 log，絕不自動寫檔或提示漏存。MAIN world `postMessage` 是信任邊界，不接受訊息提供任意 URL／credentials。
- Threads 正式發文同時攔 `configure_text_only_post`、`configure_text_post_app_feed`、`configure_text_post_app_sidecar` 與舊 GraphQL；圖片依主貼文、carousel、linked inline media 取最大 candidate，影片跳過。
- X 手機補存只掃本人、非轉推、14 天內貼文；一般頁由 background 開非作用中 `/{username}/with_replies` 取得合法 signed `UserTweetsAndReplies`，再掃 `UserTweets`。嚴格驗證 sender／tab ownership、單 job、cooldown、timeout、取消與清頁。
- 手機補存先以 status ID 查 provider；只有舊資料缺 ID 才退檔名分鐘。自動寫入、逐則 silent，最後只報總數。

## Markdown、圖片與封存

- 草稿與正式貼文共用 `getThreadItems()`／`renderContentSection()`；串文逐則 heading + code block。Fence 至少 3 個 backticks 且長於原文最長 run；引用／圖片放 block 外。
- YAML 字串全走 `escapeYaml()`；引用貼文是不可信內容。格式測試須過 `YAML.safe_load`、Unicode、dynamic fence 與 Native 寫入逐字 read-back；不批次改舊筆記。
- 每則最多 20 張，圖片先於 Markdown，路徑 `<mediaPath>/<note-stem>/image-NN.ext`；單張失敗仍存正文與遠端 URL。新貼文不建 `_assets`，舊 `_assets` 不搬不刪。
- 每 7 天封存 `created_at < cutoff` 到 `Archive/{發文,回覆,引用,串文}`；剛好 7 天保留。搬移後重算相對圖片連結、保留 mode／mtime、同名 skip，並同步更新 recent refs。
- 真實 Vault 驗收要核對 eligible、分類、YAML、broken images、conflict、第二次執行冪等性；全部 0 才完成。

## Native／iCloud、REST 與刪除

- Host ID `com.lostshin.social_post_to_obsidian`；設定 `~/Library/Application Support/Social Post to Obsidian/config.json`；商店 origin 固定 `jdfempgjnmdlokacfjmnipihhghcnomb`。
- 一般資料夾不要求 `.obsidian`；若有則用 `obsidian://` 開啟，否則交 macOS 預設 Markdown app。只接受根目錄內相對路徑，保留 symlink 邊界。
- iCloud `File.delete` 可能 `EPERM`：先看 framed response／stderr／unified log；iCloud 用 Finder alias 丟垃圾桶，本機才直接刪。
- Popup 刪除順序固定為實體目的地 → storage → UI；`SYNC_VAULT_ACTIVITY` 只有 `exists:false` 才清 storage，Host 不可用就保留。
- REST 27124 才走 HTTPS 自簽，其餘（含預設 27123）走 HTTP並顯示明文警告；不得擅自升級協定或改預設埠。

## iOS 捷徑

- 手機捷徑在 `ios-shortcut/`；改前讀其 README。schema 必須從實機 `Shortcuts.sqlite` 的 binary plist 反推，不憑記憶合成；裝置專屬 folder IDs 由使用者建立探針後讀回。
- 參數型別逐 action 不同；辭典值先 `gettext`、日期字串先 `detect.date`，`downloadurl` 不多塞 `WFHTTPMethod`。Shortcuts 會把 HTML 渲染成文字，meta 路線不可用。
- X 短文可用 syndication JSON，長文會 tombstone、引用缺失；Threads 公開頁不可取得完整內文。不要反覆單點猜測，使用同輪多變體對照實驗。

## 公開文件、Release 與 Web Store

- 「整體文案」同步檢查繁中／英文 README、GitHub About、Store listing；必要才連動 INSTALL／PRIVACY。README 改後用 GitHub 公開頁驗證渲染。
- Release workflow 綁 `v*` tag；只以上傳後同一 Release 的 `SHA256SUMS` 驗證 assets。本機重新封裝因 timestamp 可能不同 hash。
- Web Store 只上傳 Release 的 extension ZIP，不上傳 Helper。Dashboard「已發布」、語系 Approved 或待審不代表可安裝；update service ok、匿名頁有「加到 Chrome」且隔離安裝成功才算公開。
- Web Store 優先 Chrome connector；只有使用者授權才用 AppleScript。若落在 register／協議／$5 頁代表錯帳戶，不代勾或付款。

## 目前進度（2026-08-10）

- 工作樹 Extension `2.15.6`、Host `1.8.2`；整批多後端修改仍未 commit。Host 1.8.2 已安裝，原始碼與安裝檔 SHA-256 一致。
- 已完成自動驗收：三 provider 契約、migration read-back／冪等、Unicode Native framing、Notes location／upsert／附件／錯誤分類、provider 切換、原 provider queue、Popup 非同步隔離與 current-provider recent filtering。
- 已修正並以 red→green 回歸保護：migration 讀回驗證誤敗、舊 Host `Unknown native host action`、US-ASCII 解碼、Notes select／popup 卡頓、Apple error 污染 Markdown、Notes 正規化 HTML 後刪除身分誤判。
- 待人工驗收：重載 unpacked extension 確認 `2.15.6`；真實 Apple Notes 測試資料夾的 create／手改／append／open／delete／附件重試；X／Threads 多圖與 Threads inline 回覆。未授權不得代發或碰既有 Notes／Vault。
- 已公開固定基準仍是 tag `v2.4.2`（commit `8569607`）；不可把目前 dirty 工作樹或商店審查狀態宣稱成已發布版本。

## 最短專項診斷

- Provider 串台：目前 `storageProvider` → pending request generation → response.provider → recent filter → queue 原 provider。
- Notes 身分不符：popup ref externalKey → Host／安裝版號 → body legacy marker →「來源：」精確 status/post identity → locked/not-found 分類。
- Native Host：ping → 原始碼／安裝檔版本 → framed request → stderr／UTF-8 → unified log。
- 草稿復活：composer scope → editor selector／ID → draftSessionId → content/background 2 秒 guard → storage → 目的地。
- 漏回覆：`replyTo` → context/recent/source index → 三日窗 → read-back append → 失敗另存。
- Threads 圖片：REST endpoint → forwarded response → parser → CDN → binary → Markdown。
- 七日封存：cutoff／類型 → conflict → move → relative links → recent refs → 第二次執行。
- 發布：manifest version → tag → CI → Release assets/checksum → Web Store Draft → review → update service／匿名頁／隔離安裝。
