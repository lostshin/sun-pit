# 順筆 sun-pit：Chrome Web Store 發布指南

目前工作樹是 `2.19.3` 候選版。名稱、定位、繁中／英文文案與素材清單統一維護在 [商店文案](../assets/store/LISTING.md)。歷史版本資料保留在 `assets/store/publish-v2.4.0/` 與 `publish-v2.4.2/`，不作為新版送審內容。

本頁是專案操作流程，不代表商店已更新。送審前請核對官方的 [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)、[Prepare your extension](https://developer.chrome.com/docs/webstore/prepare) 與 [Privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/)。

## 品牌與安裝識別

- 對外名稱：**順筆 sun-pit**；核心理念：**社群，就是你的筆記本。**
- Repository：`lostshin/sun-pit`。
- 沿用既有商店項目，extension ID 是 `jdfempgjnmdlokacfjmnpiphhghcnomb`，不另建項目。
- Native Host ID 為 `com.lostshin.sun_pit`，設定目錄為 `~/Library/Application Support/sun-pit`；需安裝新版 Helper。
- 類別沿用既有項目設定。歷史紀錄顯示為 Tools，請以 Dashboard 當下顯示為準。

## 建立與辨識發布檔案

先執行驗證，再封裝：

```bash
node scripts/validate-extension.mjs
node tests/media-sync.test.mjs
./scripts/package-extension.sh
git diff --check
```

| 檔案 | 用途 |
| --- | --- |
| `dist/sun-pit-v2.19.3.zip` | Chrome Web Store 與 GitHub 手動安裝 |
| `dist/sun-pit-helper-v2.19.3-macos.zip` | 另行安裝的 macOS Native Helper |
| `dist/SHA256SUMS` | 這次封裝的 SHA-256 checksum |

只上傳 extension ZIP 到商店。Helper ZIP 與 checksum 放在同版本 GitHub Release。使用 Release 上傳後的 `SHA256SUMS` 核對下載檔，不以另一次本機封裝的 hash 代替。

## 商店欄位

使用 [商店文案](../assets/store/LISTING.md) 的名稱、摘要、詳細說明、單一用途與 URL。更新前確認目前帳號能管理既有 item；若出現註冊、協議或付款畫面，先確認帳號，不另建商店項目。

名稱也由 manifest 提供；新套件名稱是 `順筆 sun-pit`。本版未加入 `_locales`，英文文案不等於已提供英文安裝語系。

## 權限與資料揭露

以下描述以目前程式行為為準；Dashboard 選項請對照 [隱私權政策](../PRIVACY.md) 與當下官方說明。

| 權限或網站 | 用途 |
| --- | --- |
| `storage` | 保存目的地設定、選用的 REST API Key、草稿、最多 50 則待補存項目、最近筆記與本機維護紀錄。 |
| `nativeMessaging` | 連接使用者另行安裝的 macOS Helper，寫入 Markdown 或透過系統自動化操作 Apple 備忘錄。 |
| `notifications` | 原始分頁不存在時回報正式筆記或補存結果。 |
| `alarms` | 重試待補存內容，並依目的地能力執行封存與維護。 |
| X／Threads | 取得使用者撰寫或發佈的內容；X 手機補存只處理本人、非轉推、14 天內的貼文。 |
| `127.0.0.1` | 選用 REST 模式時連接本機 Obsidian 外掛。 |
| X／Meta 圖片 CDN | 下載所保存貼文的靜態圖片。 |

本版未新增 Chrome 權限，不使用遠端程式碼、`eval()`、`new Function()` 或外部 script。Native Helper 是另外安裝的本機程式，原始碼隨套件提供。

需對照揭露的資料包括選用的 REST API Key、貼文中的作者名稱與來源資訊、使用者生成的文字與圖片。本機處理不等於沒有處理資料，不要省略必要揭露。

資料只用於筆記保存及相關整理，不販售、不作廣告或信用評估，不傳送到開發者後端。Apple iCloud 帳號或使用者自行選擇的同步資料夾仍會依其服務設定同步。

## 素材與實機驗收

使用 [商店素材清單](../assets/store/LISTING.md#素材) 的新版素材。尺寸與規格於上傳前對照官方 [Supplying Images](https://developer.chrome.com/docs/webstore/images)。

所有展示資料必須為合成或隔離範例，不含真實 Vault 名稱、API Key、私人貼文與個資。素材展示不能替代 [候選版驗收清單](../RELEASE_NOTES.md#發布前尚待驗收)。

## Reviewer instructions

```text
sun-pit (順筆), turns the reviewer's own X and Threads posts into notes in one selected destination.

Recommended macOS test:
1. Download the matching sun-pit-helper-v*-macos.zip from the linked GitHub Release.
2. Run ./native/install-host.sh jdfempgjnmdlokacfjmnpiphhghcnomb.
3. Reload the extension, choose a writable Markdown folder in the popup, and save settings. Obsidian is optional.
4. Alternatively choose an Apple Notes account and test folder, and grant the system automation permission when requested.
5. With a test account, publish an X or Threads post and verify the saved note and images.

Other operating systems:
1. Install Obsidian and the Local REST API community plugin.
2. Choose Local REST API in the popup and enter the local API key and port.

No developer-operated server, analytics, remote code, or developer account is required. Reviewers use their own platform test account. The helper source is under native/ in both the package and public repository. The extension ID is unchanged; install the new Helper for the renamed Native Host.
```

## 送審與發布

1. 先完成候選版實機驗收；確認 tag、manifest、ZIP 版本一致，CI 通過。
2. 建立新的 `v2.19.3` Release，確認兩個 ZIP 與 checksum 可下載；不改動既有公開 tag。
3. 上傳該 Release 的 extension ZIP，更新商店文案、素材、支援與隱私 URL。
4. 讀回 Dashboard 草稿，核對新名稱、文案、權限理由與隱私揭露，再提交審查。
5. 公開後以匿名商店頁、update service 與隔離安裝確認實際可取得。Dashboard 的狀態標籤不能替代安裝驗收。

官方流程：[Publish](https://developer.chrome.com/docs/webstore/publish)、[Complete your listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing/)、[Review process](https://developer.chrome.com/docs/webstore/review-process)。
