// 共用設定與常數：background（importScripts）與 popup（<script>）載入同一份，
// 避免兩處各自維護一份判斷邏輯而彼此 drift。
const DEFAULT_BASE_PATH = '個人創作/社群推文';
const DEFAULT_MEDIA_PATH = '附件/順筆';

const STORAGE_PROVIDERS = Object.freeze({
  MARKDOWN_FOLDER: 'markdown-folder',
  OBSIDIAN_REST: 'obsidian-rest',
  APPLE_NOTES: 'apple-notes'
});

function resolveStorageProvider(settings) {
  return settings.storageProvider || STORAGE_PROVIDERS.MARKDOWN_FOLDER;
}

// 僅供舊的 Markdown 共用函式判斷傳輸方式；持久化 schema 使用 storageProvider。
function resolveStorageMode(settings) {
  const provider = resolveStorageProvider(settings);
  if (provider === STORAGE_PROVIDERS.OBSIDIAN_REST) return 'rest';
  if (provider === STORAGE_PROVIDERS.APPLE_NOTES) return 'apple-notes';
  return 'native';
}

// 平台顯示名稱；short 供檔名使用——檔名不能含 '/'，所以檔名用 'Twitter' 而非 'Twitter/X'
function platformDisplayName(platform, short = false) {
  if (platform === 'x') return short ? 'Twitter' : 'Twitter/X';
  return 'Threads';
}
