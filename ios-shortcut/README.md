# 順筆 iOS 捷徑：手機端補記

手機 app 發的文攔截不到——擴充功能只在桌面瀏覽器裡跑。這支 iOS 捷徑讓手機上的社群貼文也能成為筆記：把一則 X 貼文的連結丟給它，它會抓取內容並在 Vault 裡寫出與擴充功能格式一致的筆記。

`build_shortcut.py` 產生 `.shortcut` binary plist 並簽名。捷徑本身不是手寫的 plist，改行為請改這支 Python，不要直接編輯產出的檔案。

## 建置

```bash
cd ios-shortcut
cp config.example.json config.json    # 只需一次
python3 build_shortcut.py             # 產出 build/順筆・手機補記.shortcut（已簽名）
```

`config.json` 與 `build/` 都在 `.gitignore` 裡：兩者都含**裝置專屬 ID**，不可進版控。

### config.json 欄位

| 欄位 | 說明 |
|---|---|
| `screen_name` | 你的 X 帳號。捷徑只存這個帳號的貼文，避免剪貼簿殘留別人的連結被存進「個人創作」 |
| `shortcut_name` | 產出的檔名與捷徑名稱 |
| `vault_folder` | 存檔目標資料夾，**無法用手寫合成** |

`vault_folder` 裡的 `crossDeviceItemID` 與 `fileProviderDomainID` 是裝置專屬值，只能從實機取得：在 Shortcuts app 用 UI 建一支「探針」捷徑，放一個「儲存檔案」動作並把目標資料夾選好，存檔後從
`~/Library/Shortcuts/Shortcuts.sqlite` 的 `ZSHORTCUTACTIONS.ZDATA` 讀回（未加密 binary plist，`plutil -convert xml1` 即可）。專案裡的 `SP2O 探針` 捷徑保留供日後取用。

## 安裝到 iPhone

把 `build/順筆・手機補記.shortcut` 用 AirDrop 或 iCloud Drive 傳到手機開啟匯入。捷徑註冊為分享工作表動作（`WFWorkflowTypes: ActionExtension`），也可從剪貼簿讀連結，所以輕點背面、Siri、捷徑首頁都能觸發。

沒有輸入或不是自己的貼文時**靜默結束**，不跳通知——自動化情境下每次都彈訊息太吵。

## 資料來源與已知限制

內容來自 `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<任意非空值>`。這是唯一還活著的公開端點：

- **長貼文與已刪除的貼文回 `TweetTombstone`**，回應是空的 `{"tombstone":{}}`，拿不到任何內容。`publish.twitter.com/oembed` 已回空、X timeline 端點與爬蟲 UA 的 og:description 也都死了。
- 引用貼文資訊一律不提供。
- **Threads 內文在 Shortcuts 裡取不到**，要支援只剩官方 API（需 Meta app + OAuth）。

tombstone 時捷徑會寫一份 `待補完_<貼文ID>.md` 佔位筆記，`status: pending-content`，等你手動補內文。檔名綁貼文 ID 而不是執行時間，同一則貼文重跑會撞到既有的「檔案已存在就 exit」而被擋掉；用執行時間的話每分鐘重跑都會多存一份（vault 裡曾因此累積重複檔）。

佔位筆記的 `created` 留空。真實發文時間其實可由 snowflake 反推（`(id >> 22) + 1288834974657` 毫秒，double 精度足夠），但 Shortcuts 端要做這個換算得用「調整日期」動作，而使用者的捷徑資料庫、系統 framework、Apple 內建 gallery 捷徑裡都找不到該動作的實機樣本。**參數形狀猜錯會靜默回空值**（見下），所以寧可留白也不寫假時間。要補完這塊，先用 UI 建一支含「調整日期」的探針捷徑再讀回 schema。

## 改捷徑前必讀

**schema 一律從實機反推，不要憑記憶寫。** 以下全部會靜默回傳空值、不報錯：

| 症狀 | 原因 | 解法 |
|---|---|---|
| 動作輸出恆為空 | 參數序列化型別**逐動作不同** | `text.replace.WFInput`／`format.date.WFDate` 要 `WFTextTokenString`；`getvalueforkey.WFInput` 要 `WFTextTokenAttachment` |
| 條件判斷綁不上比較值 | 輸入是「辭典值」不是純文字 | `getvalueforkey` 的產出一律先過 `gettext` 轉型 |
| `format.date` 空 | 餵它字串 | 先用 `detect.date` 解析成日期物件 |
| `downloadurl` 整個失效 | 多寫了 `WFHTTPMethod` | 實證範例沒有的 key 就不要加 |
| HTML 抓不到 meta 標籤 | Shortcuts 把 HTML 渲染成純文字 | 此路不通，只能改用 JSON 端點 |

除錯不要「改一個猜測 → 重測」，一輪只換到一位元資訊。改用**並排對照實驗**：同一支捷徑放多個變體、用 `showresult` 一次顯示全部結果。

## 與擴充功能的關係

檔名沿用 `generateFilename()` 的規則（`created_at` UTC 轉本機時間），與桌機存的筆記自然去重，實測產出 byte-identical。這支捷徑不屬於 Chrome 擴充功能封裝範圍，`scripts/package-extension.sh` 用明列清單複製檔案，不會把 `ios-shortcut/` 帶進商店 ZIP。
