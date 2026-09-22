<!-- 本檔是本專案唯一規則檔;CLAUDE.md 是指向本檔的 symlink。
     裁減／最佳化時只刪過期或重複內容,不得刪除任一工具專屬規則。 -->

# AGENTS.md

本檔供 Claude Code 與 Codex 共用，記錄目前架構、不可回退的產品契約、已驗證陷阱與最短驗收路徑。硬上限 250 行；現況以 `manifest.json`、`native/host.rb`、程式與測試為準，新增經驗時先取代過時內容，不要重抄。

## 開工、修改與交付

1. 先確認 cwd 為 `/Users/lokunlim/projects/sun-pit`，再跑 `git status --short`；既有 dirty files 屬於使用者。只碰任務檔，不順手重構、格式化、stage 或發布。
2. 用 `rg -n` 追函式、訊息與測試，不先掃完整 repository。回歸優先擴充 `tests/media-sync.test.mjs` 的 VM、假 Native Host／`osascript`、YAML 與隔離資料夾 harness。
3. 修 bug 必須先新增可重現測試並確認 FAIL，再修到 PASS；靜態 source assertion 只能保護 UI 接線，資料與流程應以可執行測試驗證。
4. 大段重寫前確認檔案可由 git 回復；dirty 檔先同目錄備份。每個 changed line 都要能追溯到使用者需求。
5. 不操作日常 Chrome profile、真實貼文、真實 Notes／Vault，除非使用者明確授權。社群代發目前暫停。
6. 只有發布任務才跑 `./scripts/package-extension.sh`；公開 tag 不移動、不刪除、不重打。

## 專案定位與架構

- 品牌為「順筆 sun-pit」，理念是「直接把社群軟體當成筆記軟體」；repository 為 `lostshin/sun-pit`。商店 extension ID 保留；unpacked ID 可能隨載入路徑改變。Host 與設定目錄改用 sun-pit，既有筆記不搬移。
- Chrome Manifest V3 擴充功能；把 X／Threads 貼文與圖片寫到單一目的地：本機 Markdown 資料夾、Obsidian Local REST API 或 Apple 備忘錄。無 build step、無第三方 runtime 依賴。
- macOS 的 Markdown 資料夾／Apple 備忘錄只需 Native Helper，不需 Obsidian；只有 REST 模式依賴 Obsidian 與其外掛。Windows／Linux 目前僅支援 REST 路線。
- MAIN world `content/interceptor.js` 攔 fetch／XHR；isolated world `content/common.js` + 平台檔擷取 DOM；`background.js` 管 provider、草稿、queue、recent refs、合併與 alarm；`popup/*` 只透過 background 操作目的地。
- `shared/settings.js` 與 `providers/*.js` 是 background／popup 的共用設定與 adapter registry。新增或改名共用檔時同步更新 validator 與 package 必含清單。
- 中立模型是 `SocialPostData`；工作流不得依賴 Markdown path。`StorageRef` 是 file ref 或 Notes `{provider,noteId,title,externalKey}`；開啟、刪除、exists 一律交給 ref 所屬 provider。
- 每次只寫一個目前目的地，但 queue 綁建立時的原 provider；切換後仍回原目的地補存，不複製 API Key。
- storage schema v3 的 `contentDedupeIndex` 只存 fingerprint、sources 與 ref；正文仍以目的地為真相。索引依 provider＋location 分區，不可跨 Vault／Notes folder 共用。

## 版本、重載與驗證（硬規則）

- Extension 版本真相是 `manifest.json.version`；程式行為 bug fix bump patch、可見新功能 bump minor。Host 行為另 bump `HOST_VERSION`，並同步提高 `MIN_NATIVE_HOST_VERSION`，避免新版流程搭配舊 Host。
- Host 修改後執行 installer，並以 checksum／`cmp` 讀回確認安裝檔等於 `native/host.rb`。Web Store 不會代裝 Helper。
- 每次程式改動依序跑：改過的 JS `node --check`、Host `ruby -c`、`node scripts/validate-extension.mjs`、`node tests/media-sync.test.mjs`、`git diff --check`。
- Runtime 驗收固定：`chrome://extensions` 重新載入 → 重新整理所有 X／Threads 分頁 → 確認 popup／content／background 顯示同版號 → 清空後重看擴充功能錯誤頁。
- `Extension context invalidated` 通常是舊 content script；只按「重新載入」，不要移除再重加（會清掉 `chrome.storage.local`）。錯誤頁行號可能套在新檔上，先比版本與時間戳。
- 自動測試／validator／toast 不等於真實 E2E；未實測的 Notes、X／Threads、多圖或 Vault 行為必須明說。

## Provider、設定 migration 與 Popup 隔離

- `storageSchemaVersion` migration 是「不批次遷移資料」的唯一例外：先轉設定、refs、thread contexts、drafts、queue 與 dedupe index，寫入後 read-back 深度驗證成功才刪舊 keys；失敗時保留舊資料並停止寫入。正常路徑不得保留舊 schema fallback。
- 「Unknown native host action」先查原始碼 Host 版本、安裝檔版本與 manifest allowed origin；不要先改 background action 名。Host 每次 native message 都是新程序，不依賴 request 間記憶體。
- Popup 初次開啟不得同步列舉 Notes 或逐筆 exists；Notes locations 用本機 cache、只有進入／重新載入 Apple 面板才更新，自動 activity sync 帶 `skipAppleNotes: true`。
- Provider selector 改變時立即清掉前一 provider 的 form／action error，連線卡顯示「儲存後生效」。所有非同步檢查帶 request generation；舊 provider 晚回來的 response 不得覆寫新狀態。
- `recentSaves` 在 storage 保留跨 provider refs，但 Popup「最近儲存」只顯示目前已生效 provider；storageProvider 改變後重繪。Queue UI 必須標成「原目的地」，不得冒充目前目的地錯誤。
- Apple queue 失敗只保留 queue；Markdown 模式的連線狀態只反映 Markdown Helper，不得自動驗證 Apple 身分。

## 跨平台去重與既有資料合併

- 內容身分不是檔名、分鐘、`recentSaves` 或 source URL：只對原創貼文／原創串文依序串接全文，trim 並把連續空白壓成一格後算 SHA-256。回覆、引用與純圖片排除；大小寫、標點或正文不同仍是不同文章。
- 只合併 X 與 Threads 的跨平台同文；同平台重發是獨立作品。檔名撞名時先核對 source identity；不同來源加 `_2`、`_3`，絕不可直接覆寫。
- 自動去重只作用於目前目的地；手動掃描一次跑所有已設定 provider，但每個 provider／location 獨立分組與報錯，不跨服務搬移或刪除。
- 同 fingerprint 的 prepare→write→index 共用 destination-scoped lock；所有 fingerprint 對 `contentDedupeIndex` 的 read-modify-write 另行序列化，避免並行時遺失索引。
- 新建或合併筆記寫 `content_fingerprint`、`platforms`、`sources[{platform,url,published_at,external_key}]`；舊 scalar `platform/source/source_url` 只供既有資料讀取。任何 source identity 都要能回查同一 ref。
- 掃描對目的地必須唯讀，結果與 revision snapshot 存本機並可在 Popup 重開後恢復；使用者確認後才合併。掃描後任一筆內容變更就整組 skip，不可套用舊預覽。
- 重複文章掃描只有 `result.errors.length === 0` 才可呼叫 `replaceDedupeScopeIndex()`；部分讀取失敗必須保留該 scope 原索引，provider 回報 `ok:false`／`complete:false` 與 warnings。成功讀取的預覽可保留；Popup 當次與重開後皆須呈現不完整原因，不可以頂層 `ok:true` 判定所有目的地成功。回歸用缺檔 fixture 比對掃描前後索引，並以 Popup VM 驗證警告與恢復狀態。
- canonical 固定取最早建立者並保留標題、路徑、正文與手改。duplicate 的可辨識額外區塊附加到「合併保留內容」；無法可靠區分時不得猜測或刪除。
- 圖片按實際 bytes 的 SHA-256 去重，不用 URL／檔名；不同轉碼都保留。流程固定：讀回全部→複製唯一媒體→寫 canonical→讀回驗證 fingerprint／所有 sources→刪 duplicate→清專屬媒體→同步 recent、thread contexts 與 index。
- canonical 已更新但 duplicate 刪除失敗時，下次掃描須用 canonical 已收錄的 exact source identity 產生 cleanup group；操作必須冪等。
- Provider adapter 必須實作 `scanPublished`／`mergeDuplicateGroup`。Notes 掃描只能由使用者觸發並分頁；Popup 初開、activity sync 與一般發文不得暗中列舉整個 Notes folder。

## 維護狀態與索引修復

- `archiveStatus:<destination scope>` 持久保存封存開始、結果、失敗與最後成功時間；`getMaintenanceStatus()` 只讀本機狀態／alarm，不能因此列舉 Notes。Popup 晚回來的 response 必須受 request generation 保護。
- 索引檢查 `checkContentIndex()` 只針對目前目的地；`contentIndexCheck` 保存 scope、scanId、舊 entry、候選與 revision，重開 Popup 可恢復。不同於「重複文章」掃描所有已設定目的地，不得混用範圍。
- 修復只接受原位置不存在、正文 fingerprint 與全部來源身分相符、候選位置唯一的項目。`repairContentIndex()` 重新核對 scope／scanId／revision／索引快照，序列化寫入後 read-back；掃描不完整停止，變更或多筆相符就略過，不猜測、不刪掉未找回的索引。
- 索引修復不搬移／修改／刪除筆記、不修圖片、不重建 recent。封存更新 `contentDedupeIndex` 限當次 destination scope；recent／thread refs 另核對 provider，不可只憑相同 path 跨目的地改寫。

## Apple 備忘錄契約與已驗證陷阱

- Notes 只透過 scripting dictionary 與 Native Helper；不碰私有 SQLite。所有正文／附件經 `0600` temp file 傳入，不把使用者內容插值進 AppleScript，ensure 清除暫存檔。
- Native stdout 只能是 4-byte little-endian 長度 + UTF-8 JSON；子程序 stdout／stderr 必須捕捉並用 UTF-8 解碼。Chrome 啟動 Host 不帶 `LANG`，`Encoding.default_external` 與 filesystem encoding 都退成 US-ASCII，`Dir.each_child` 讀到的中文檔名一碰 UTF-8 正文就 `incompatible character encodings`；host.rb 開頭固定 `Encoding.default_external = Encoding::UTF_8`，Ruby 測試一律帶 `LANG=C` 與中文檔名，不可只用 ASCII fixture。
- Apple Notes 會正規化 HTML 並移除 `data-sp2o-key`；它只能當 legacy fast path，不能是唯一身分證明。`find/read/upsert/show/delete/exists` 必須退回精確比對「來源：」區塊內的 X status ID／Threads post code。
- 刪除／更新前先讀回驗證，執行動作時再以剛找到的精確 marker 重查，避免 note ID 指錯或貼文 ID 前綴誤判；真正不符仍回 `NOTES_IDENTITY_MISMATCH`，不可為了好刪而直接信任 note ID。
- `notesListPosts`、`notesAttachmentHashes`、`notesMergeDuplicates` 同樣只走 scripting dictionary；合併前驗證每篇 revision，合併後驗證所有來源 marker 才刪 duplicate。附件先匯出私有 temp 算 SHA-256，不把大圖塞進掃描預覽。
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
- 具 `capabilities.archive` 的 Markdown／REST provider 每日檢查 `created_at < 7 天 cutoff`，啟動後約一分鐘先跑一次；Apple Notes 不封存。SW 啟動、popup 儲存設定（`RETRY_QUEUE`）與 alarm 觸發三處一律走 `syncArchiveMaintenance()` 依 capabilities 判斷，不得各自列 provider 白名單。`delayInMinutes` 不可等於整個週期——reload 會清空 alarm 並重新排到一個週期後，永遠跑不到。搬到 `Archive/{發文,回覆,引用,串文}` 後重算圖片連結、保留 mode／mtime、同名 skip，並同步 recent、thread contexts 與 dedupe index refs。
- 真實 Vault 驗收要核對 eligible、分類、YAML、broken images、conflict、第二次執行冪等性；全部 0 才完成。

## Native／iCloud、REST 與刪除

- Host ID `com.lostshin.sun_pit`；設定 `~/Library/Application Support/sun-pit/config.json`；商店 origin 固定 `jdfempgjnmdlokacfjmnipihhghcnomb`。
- 一般資料夾不要求 `.obsidian`；若有則用 `obsidian://` 開啟，否則交 macOS 預設 Markdown app。未安裝 Obsidian 時應選一般資料夾；含 `.obsidian` 的資料夾仍可儲存，但「開啟」會嘗試啟動 Obsidian。只接受根目錄內相對路徑，保留 symlink 邊界。
- iCloud `File.delete` 可能 `EPERM`：先看 framed response／stderr／unified log；iCloud 用 Finder alias 丟垃圾桶，本機才直接刪。
- Popup 刪除順序固定為實體目的地 → storage → UI；`SYNC_VAULT_ACTIVITY` 只有 `exists:false` 才清 storage，Host 不可用就保留。
- REST 27124 才走 HTTPS 自簽，其餘（含預設 27123）走 HTTP並顯示明文警告；不得擅自升級協定或改預設埠。

## iOS 捷徑

- 手機捷徑在 `ios-shortcut/`；改前讀其 README。schema 必須從實機 `Shortcuts.sqlite` 的 binary plist 反推，不憑記憶合成；裝置專屬 folder IDs 由使用者建立探針後讀回。
- 參數型別逐 action 不同；辭典值先 `gettext`、日期字串先 `detect.date`，`downloadurl` 不多塞 `WFHTTPMethod`。Shortcuts 會把 HTML 渲染成文字，meta 路線不可用。
- X 短文可用 syndication JSON，長文會 tombstone、引用缺失；Threads 公開頁不可取得完整內文。不要反覆單點猜測，使用同輪多變體對照實驗。

## 品牌、全專案改名與素材驗收

- 中文「順筆」、英文識別 `sun-pit` 與理念已確定。全專案改名須涵蓋 manifest／Popup／通知與 log、三份 README、安裝／隱私／貢獻文件、商店文案、workflow／套件檔名、Helper／測試、素材、GitHub About／remote 及本機目錄，不可只改首頁。
- 搜尋時從 repository 根目錄執行 `rg --hidden --no-ignore` 並排除 `.git`；同時查大小寫、空白／連字號／底線變體與檔名。普通 `rg` 會漏掉忽略的 dist、快取、備份；還須列出並解壓檢查 ZIP 內檔案，不能以原始碼零筆宣稱全專案零筆。
- SVG／HTML 改字後重產 PNG、GIF／MP4，並實際看圖；掃文字不能驗證點陣圖。現有流程：`rsvg-convert` 產生 SVG 對應 PNG，`node scripts/capture-demo.mjs` 用隔離 Chrome profile 與合成資料重產展示影片；不得拿日常帳號或筆記當素材。
- 使用者要求清除全部舊名時，工作樹中的歷史素材也要處理；Git 歷史、公開 tag 與已發布 assets 不改寫。舊 ZIP、快取及改前備份完整封存到專案外，避免搜尋再命中；不可刪除使用者原本的備份來湊零筆。
- 搬移本機目錄與 GitHub rename 是不同操作。先核對目標不存在、搬後 cwd／remote 正確，再重裝 Helper、讀回 `allowed_origins` 與安裝檔；installer 會重寫 origin 清單，不能假設一次手動追加的 origin 永久保留。
- 改路徑不會替 Chrome 轉移 unpacked 設定。保留原擴充功能直到確認設定／queue，禁止先移除再重加；載入新路徑、extension ID 與 storage 延續須另做 runtime 驗收，不能用 Helper 安裝成功替代。
- dirty 規則檔仍先同目錄備份再改；驗收後備份可移到專案外封存。封裝使用必含檔案／副檔名清單，驗證 ZIP 不含 `.bak*`、測試資料、規則檔或私人設定；備份不能因 wildcard 被打進套件。

## 公開文件、Release 與 Web Store

- 新版商店文案來源是 `assets/store/LISTING.md`，發布流程見 `docs/CHROME_WEB_STORE.md`。本機文件修改、GitHub repository／About 改名、commit／push、Release、商店草稿／送審／公開須分別回報，不得互相代稱。README 推送後才做公開頁渲染驗證；未推送時只回報本機檢查。
- Release workflow 綁 `v*` tag；只以上傳後同一 Release 的 `SHA256SUMS` 驗證 assets。本機重新封裝因 timestamp 可能不同 hash；checksum 檔中的相對檔名以 `dist/` 為工作目錄執行 `shasum -a 256 -c SHA256SUMS`。
- Web Store 只上傳 Release 的 extension ZIP，不上傳 Helper。Dashboard「已發布」、語系 Approved 或待審不代表可安裝；update service ok、匿名頁有「加到 Chrome」且隔離安裝成功才算公開。
- Web Store 優先 Chrome connector；只有使用者授權才用 AppleScript。若落在 register／協議／$5 頁代表錯帳戶，不代勾或付款。

## 目前進度（2026-09-22）

- **位置與品牌**：本機已搬至 `/Users/lokunlim/projects/sun-pit`；GitHub repository／About 與 origin 已改為 `lostshin/sun-pit`。現有 `CLAUDE.md -> AGENTS.md` 接線正常。舊路徑不再使用。
- **版本與提交**：Extension `2.19.2`、schema v3、Host／最低需求 `1.10.0`。本輪獲授權將掃描修復、規則、先前改名、維護功能、素材與文件一併 commit／push；實際同步狀態以 `git log`／`git status` 及遠端 ref 為準，不在本檔寫會立即過期的 HEAD。尚未建立新版 tag／Release 或更新商店。
- **已完成功能**：Popup 封存狀態與目前目的地的索引預覽／確認修復；封存不再跨 destination scope 改寫索引。正文／來源／revision／快照重新驗證、失敗保留與讀回已測；詳細契約見上方，避免在進度區重抄。
- **名稱清理**：原始碼、文件、Helper、測試及工作樹歷史素材已統一；文字、忽略檔、檔名與新版 ZIP 掃描舊名為 0（不含 Git 歷史）。SVG 對應 PNG、Popup 圖與示範 GIF／MP4 已重產；舊產物／快取／備份封存在 `~/sun-pit-archives/20260922-033215/`。
- **Helper 安裝**：新路徑 installer 已執行，`cmp` 確認安裝的 host.rb 等於來源；原資料夾設定已在本機複製至新設定目錄，未搬移筆記。安裝 manifest 目前授權商店、新路徑 unpacked `hefhgppinnboklgpbdjoplgehpkanamg` 及既有 unpacked `heagjngollcaijefoajffecndijplmeb`；最後一項是額外保留，重跑 installer 前須留意。
- **本輪修復與驗證**：astra-low 子代理重現「部分掃描覆寫完整索引」，回歸先 FAIL 後 PASS；修復與 Popup 警告／重開恢復已納入 `tests/media-sync.test.mjs`。`2.19.2` validator、完整測試、JS／Ruby 語法與 `git diff --check` 通過；獨立 review 未發現本次引入的可確認問題。隔離真實 Helper 保存→合併→封存→讀回及重跑 0 筆通過；REST／Notes 與 Popup 為替身／VM，不能保證所有既有功能或平台 E2E 無回歸。
- **發布候選**：README、INSTALL、RELEASE_NOTES、商店指南與展示素材已同步為 `2.19.2`；本機 `dist/sun-pit-v2.19.2.zip`、Helper ZIP 與 `SHA256SUMS` 已重產並通過完整性檢查。仍須建立不可移動的 `v2.19.2` tag／Release，再以 Release `SHA256SUMS` 驗證 extension ZIP；線上商店狀態須從 Dashboard 讀回。
- **資料待核實**：8/26 曾繞過 extension 直接呼叫 Host 補封存 111 筆，當時約 20 筆去重 refs 指舊位置；本輪未掃描日常 Vault，不宣稱已修復。先用新索引檢查預覽，再由使用者確認。
- **待處理候選**：合併結果／逐組錯誤被重新掃描覆蓋；Notes locations 過期回應可能改寫新 provider 提示（尚未動態重現）；iOS 雙引號摘要與桌機檔名不一致、固定 fence 未處理正文 backticks。這些尚未修復，不能因本輪 review 通過就視為結案；tombstone 佔位筆記是刻意限制。
- **下一步**：核對新路徑 Chrome ID／storage 延續與各 context 版本，再驗收 Chrome→Host alarm、測試 Notes folder 合併／附件、X／Threads 同文／多圖／關閉 Popup。commit／push 不等於發布驗收；真實發文與日常資料操作仍須授權，平台驗收通過後才進入 Release／商店流程。

## 最短專項診斷

- Provider 串台：目前 `storageProvider` → pending request generation → response.provider → recent filter → queue 原 provider。
- Notes 身分不符：popup ref externalKey → Host／安裝版號 → body legacy marker →「來源：」精確 status/post identity → locked/not-found 分類。
- Native Host：ping → 原始碼／安裝檔版本 → framed request → stderr／UTF-8 → unified log。
- 草稿復活：composer scope → editor selector／ID → draftSessionId → content/background 2 秒 guard → storage → 目的地。
- 漏回覆：`replyTo` → context/recent/source index → 三日窗 → read-back append → 失敗另存。
- Threads 圖片：REST endpoint → forwarded response → parser → CDN → binary → Markdown。
- 七日封存：`capabilities.archive` → alarm 是否存在（`chrome.alarms.getAll`）→ Host 編碼／`LANG` → cutoff／類型 → conflict → move → relative links → recent refs → 第二次執行。先看 Popup 目的地封存狀態與 SW log；需要重現且目的地已獲授權時，再於 SW console 跑 `archiveOldSocialPosts(await getStorageSettings())`。
- 重複未合併：eligibility → normalized text／fingerprint → destination scope → index candidate → ref read-back → sources；既有掃描再查 revision、manual sections、media hashes 與 delete-after-verify。
- 改名殘留：cwd／目錄名 → 含忽略檔的變體搜尋 → 檔名／ZIP 內文 → PNG／影片 → Helper／Chrome ID → remote／線上狀態。
- 索引修復：目前 scope → contentIndexCheck scanId → 原 ref exists → fingerprint＋全部來源 → 唯一候選／revision → entry 快照 → serialized write／read-back。
- 發布：manifest version → tag → CI → Release assets/checksum → Web Store Draft → review → update service／匿名頁／隔離安裝。
