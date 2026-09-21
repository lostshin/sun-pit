# 順筆 v2.4.0

將 X 與 Threads 的貼文、串文和靜態圖片備份成結構清楚、容易複製的 Obsidian Markdown。

## 這個版本

- 每一則貼文與串文項目都以 Markdown code fence 包覆，方便直接複製。
- 支援 X／Threads 連續串文，依原順序整理並寫入 `thread_count`。
- 改善 YAML frontmatter、貼文資訊區塊與圖片相對路徑。
- 改善草稿同步速度，並修正相同草稿內容重複寫入的問題。
- 保留 Native Helper、Local REST API、離線補存、Popup 預覽／刪除／同步等功能。

## 安裝

- Chrome extension：`sun-pit-v2.4.0.zip`
- macOS Native Helper：`sun-pit-helper-v2.4.0-macos.zip`
- 完整安裝步驟請見 `INSTALL.md`。

Chrome Web Store 版使用者若採 Native Helper，請執行：

```bash
./native/install-host.sh jdfempgjnmdlokacfjmnipihhghcnomb
```

Native Host 實際版本：`1.1.3`。

下載後可用 `SHA256SUMS` 驗證檔案完整性。
