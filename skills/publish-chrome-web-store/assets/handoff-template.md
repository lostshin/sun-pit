## Chrome Web Store 交付

| 項目 | 結果 |
|---|---|
| 目標／送審版本 | `{{TARGET_VERSION}}` |
| Dashboard 狀態 | `{{DASHBOARD_STATE}}` |
| 目前公開版本 | `{{CURRENT_PUBLIC_VERSION}}` |
| 自動發布 | `{{AUTO_PUBLISH_STATE}}` |
| Release tag | `{{RELEASE_TAG}}` |
| Release asset | `{{RELEASE_ASSET}}` |
| SHA-256 | `{{SHA256}}` |
| manifest version | `{{MANIFEST_VERSION}}` |
| Repository 變更 | `{{REPOSITORY_CHANGES}}` |
| 上傳副本 | `{{STAGED_COPY}}` |

已完成的檢查：

- [ ] Release 不是 draft／prerelease
- [ ] asset 與同一 Release 的 `SHA256SUMS` 相符
- [ ] ZIP 根目錄 `manifest.json` 版本等於 tag
- [ ] Dashboard publisher 與 item ID 正確
- [ ] 草稿版本與權限已讀回
- [ ] 隱私權與發布範圍已檢查
- [ ] 儲存成功訊息已確認
- [ ] 提交成功訊息與 `待審查` 已讀回

尚待確認：

- [ ] 審查結果
- [ ] 匿名商店頁顯示目標版本且可安裝
- [ ] update service 提供目標版本
- [ ] 隔離 profile 安裝成功

結論：`{{SUBMITTED_OR_PUBLIC_CONCLUSION}}`
