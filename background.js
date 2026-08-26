// Service Worker - 處理貼文存檔

// 啟動時印出版本，方便在 SW console 確認載入的版本
try {
  console.log('[Social Post to Obsidian] background v' + chrome.runtime.getManifest().version + ' 已啟動');
} catch (e) { /* 測試環境略過 */ }

// 共用設定邏輯與預設路徑（popup 亦載入同一份，見 shared/settings.js）
importScripts(
  'shared/settings.js',
  'providers/base.js',
  'providers/markdown-folder.js',
  'providers/obsidian-rest.js',
  'providers/apple-notes.js'
);

// 監聽來自 content script 的訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;
  console.log('[Social Post to Obsidian] Received:', message.type, message.data?.platform);

  switch (message.type) {
    case 'SAVE_DRAFT':
      scheduleDraftSave(message.data, tabId);
      break;
    case 'PUBLISH_DRAFT':
      enqueue(message.data.platform, async () => {
        const accepted = await handlePublishDraft(message.data, tabId);
        if (accepted) discardPendingDraftSave(message.data);
      });
      break;
    case 'SAVE_POST':
      // 自動補存要依實際結果回報數量，因此回應處理結果而非 fire-and-forget
      enqueue(message.data.platform, () => handleSavePost(message.data, tabId, message.silent))
        .then((result) => sendResponse(result || { ok: false, error: '存檔未完成' }));
      return true;
    case 'RETRY_QUEUE':
      enqueue('offline-retry', async () => {
        await retryOfflineQueue();
        syncArchiveMaintenance(await getStorageSettings());
      });
      break;
    case 'GET_NATIVE_STATUS':
      sendNativeRequest({ action: 'ping' }).then(
        (response) => sendResponse(nativeHostStatusResponse(response)),
        (error) => sendResponse(nativeErrorResponse(error))
      );
      return true;
    case 'GET_STORAGE_STATUS':
      getStorageStatus().then(
        (response) => sendResponse(response),
        (error) => sendResponse(nativeErrorResponse(error))
      );
      return true;
    case 'LIST_NOTES_LOCATIONS':
      sendNativeRequest({ action: 'notesLocations' }).then(
        (response) => sendResponse(response),
        (error) => sendResponse(nativeErrorResponse(error))
      );
      return true;
    case 'OPEN_STORAGE_ACTIVITY':
      openStorageActivity(message.ref).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'CHOOSE_NATIVE_VAULT':
      chooseNativeVault().then(
        (response) => sendResponse(response),
        (error) => sendResponse(nativeErrorResponse(error))
      );
      return true;
    case 'CLEAR_AUTO_DRAFTS':
      clearAutoDrafts().then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, cleared: 0, error: error.message })
      );
      return true;
    case 'SYNC_VAULT_ACTIVITY':
      syncVaultActivity({ skipAppleNotes: message.skipAppleNotes === true }).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'FIND_MISSING_POSTS':
      findMissingPosts(message.posts).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'ENSURE_X_BACKFILL_SCAN':
      ensureXBackfillScan(message.author, sender).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'CANCEL_X_BACKFILL_SCAN':
      cancelXBackfillScan(sender).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, canceled: false, error: error.message })
      );
      return true;
    case 'X_BACKFILL_RESULTS':
      relayXBackfillResults(message.posts, sender).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, relayed: false, error: error.message })
      );
      return true;
    case 'DELETE_VAULT_ACTIVITY':
      deleteVaultActivity(message).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'SCAN_DUPLICATE_POSTS':
      scanDuplicatePosts().then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'GET_DUPLICATE_SCAN_SESSION':
      getDuplicateScanSession().then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
    case 'MERGE_DUPLICATE_POSTS':
      mergeDuplicatePosts(message.scanId, message.groupIds).then(
        (response) => sendResponse(response),
        (error) => sendResponse({ ok: false, error: error.message })
      );
      return true;
  }

  // 同步回應，避免 content script 因 port closed 錯誤而重送訊息
  sendResponse({ ok: true });
});

// 每個平台一條序列，確保草稿存檔與發佈依收到的順序執行
const taskChains = {};
// 同一平台只保留最新一份待寫草稿，避免 Native Host 較慢時累積多次舊快照，
// 讓正式發佈必須在整串草稿後面排隊。
const draftSaveStates = {};
// 記錄每平台最後發佈的貼文時間，用來丟棄遲到的舊草稿
const lastPublishTimestamp = {};
// 同一次 composer session 發佈成功後，可能還會收到 X 在 DOM 收尾時送出的
// input/blur。按 session 丟棄，避免已刪除的草稿被較晚訊息重新建立。
const publishedDraftSessions = {};
const publishedDraftSessionsLoaded = {};
const publishedDraftTabSettles = {};
const PUBLISHED_DRAFT_SESSION_TTL_MS = 5 * 60 * 1000;
const POST_PUBLISH_SETTLE_MS = 2000;
const STORAGE_SETTING_KEYS = [
  'storageSchemaVersion',
  'storageProvider',
  'markdownFolderSettings',
  'obsidianRestSettings',
  'appleNotesSettings'
];
const NATIVE_HOST_NAME = 'com.lostshin.social_post_to_obsidian';
const MIN_NATIVE_HOST_VERSION = '1.9.2';
const MAINTENANCE_ALARM = 'sp2o-vault-maintenance';
const ARCHIVE_ALARM = 'sp2o-obsidian-archive';
const LEGACY_ARCHIVE_ALARM = 'sp2o-weekly-archive';
const ARCHIVE_ALARM_DELAY_MINUTES = 1;
const ARCHIVE_ALARM_PERIOD_MINUTES = 24 * 60;
const ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_POST_FOLDERS = Object.freeze({
  post: '發文',
  reply: '回覆',
  quote: '引用',
  thread: '串文'
});
const X_BACKFILL_JOB_KEY = 'xBackfillScanJob';
const X_BACKFILL_LAST_KEY = 'xBackfillLastCompletedAt';
const X_BACKFILL_TIMEOUT_ALARM = 'sp2o-x-backfill-timeout';
const X_BACKFILL_COOLDOWN_MS = 15 * 60 * 1000;
const X_BACKFILL_TIMEOUT_MS = 90 * 1000;
// 發文後 72 小時內回覆自己，視為同一篇的追加內容。
const RECENT_THREAD_APPEND_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const THREAD_CONTEXT_KEY = 'recentThreadContexts';
const THREAD_CONTEXT_LIMIT = 100;
const CONTENT_DEDUPE_INDEX_KEY = 'contentDedupeIndex';
const DUPLICATE_SCAN_SESSION_KEY = 'duplicateScanSession';
let storageMigrationPromise;
let storageMigrationError;
let providerRegistry;
let contentDedupeIndexMutation = Promise.resolve();

async function getStorageSettings() {
  await ensureStorageSchema();
  const stored = await chrome.storage.local.get(STORAGE_SETTING_KEYS);
  const provider = stored.storageProvider || SP2OStorage.PROVIDERS.MARKDOWN_FOLDER;
  const providerSettings = provider === SP2OStorage.PROVIDERS.OBSIDIAN_REST
    ? stored.obsidianRestSettings
    : provider === SP2OStorage.PROVIDERS.APPLE_NOTES
      ? stored.appleNotesSettings
      : stored.markdownFolderSettings;
  return {
    ...stored,
    ...(providerSettings || {}),
    storageProvider: provider
  };
}

async function ensureStorageSchema() {
  if (storageMigrationError) throw storageMigrationError;
  if (storageMigrationPromise) return storageMigrationPromise;
  storageMigrationPromise = (async () => {
    const snapshot = await chrome.storage.local.get(null);
    const migration = SP2OStorage.migrationFor(snapshot);
    if (!migration.changed) return;

    const schemaVersion = migration.updates.storageSchemaVersion;
    const dataUpdates = { ...migration.updates };
    delete dataUpdates.storageSchemaVersion;
    await chrome.storage.local.set(dataUpdates);
    const readBack = await chrome.storage.local.get(Object.keys(dataUpdates));
    const verified = Object.entries(dataUpdates).every(([key, value]) => (
      storageValuesEqual(readBack[key], value)
    ));
    if (!verified) {
      throw new Error('儲存設定升級讀回驗證失敗；舊設定已保留，已停止寫入');
    }
    await chrome.storage.local.set({ storageSchemaVersion: schemaVersion });
    const versionReadBack = await chrome.storage.local.get('storageSchemaVersion');
    if (versionReadBack.storageSchemaVersion !== schemaVersion) {
      throw new Error('儲存設定升級讀回驗證失敗；舊設定已保留，已停止寫入');
    }
    await chrome.storage.local.remove(migration.removeKeys);
  })().catch((error) => {
    storageMigrationError = error;
    throw error;
  });
  return storageMigrationPromise;
}

function storageValuesEqual(actual, expected) {
  return JSON.stringify(canonicalStorageValue(actual)) === JSON.stringify(canonicalStorageValue(expected));
}

function canonicalStorageValue(value) {
  if (Array.isArray(value)) return value.map(canonicalStorageValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalStorageValue(value[key])])
  );
}

function getProvider(settings) {
  if (!providerRegistry) providerRegistry = SP2OStorage.createRegistry(providerDependencies());
  const provider = providerRegistry.get(settings.storageProvider);
  if (!provider) throw new Error(`不支援的儲存目的地：${settings.storageProvider}`);
  return provider;
}

async function sendNativeRequest(message) {
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);
  } catch (error) {
    // Host 無法啟動或中途斷線（未安裝、崩潰）：暫時性問題，正式貼文可進離線佇列
    error.isStorageUnavailableError = true;
    throw error;
  }
  if (!response?.ok) {
    if (/Unknown native host action/i.test(String(response?.error || ''))) {
      response = nativeHostUpdateResponse(response?.version);
    }
    // Host 有回應但拒絕（Vault 未設定、路徑不合法）：重試不會自己恢復，不進佇列
    const error = new Error(response?.error || '本機 Helper 沒有回應');
    error.isNativeHostError = true;
    if (response?.code === 'NOTES_UNAVAILABLE') error.isStorageUnavailableError = true;
    error.nativeResponse = response;
    throw error;
  }
  return response;
}

function nativeErrorResponse(error) {
  const message = String(error?.message || '本機 Helper 無法使用');
  if (error?.nativeResponse?.code) return error.nativeResponse;
  if (/Unknown native host action/i.test(message)) {
    return nativeHostUpdateResponse(error?.nativeResponse?.version);
  }
  if (/Specified native messaging host not found/i.test(message)) {
    return {
      ok: false,
      code: 'NATIVE_HOST_NOT_FOUND',
      error: '找不到本機 Helper。Chrome 重新安裝後，請再次執行 Helper 安裝程式；原本的資料夾設定會保留。'
    };
  }
  if (/native messaging host.*forbidden/i.test(message)) {
    return {
      ok: false,
      code: 'NATIVE_HOST_FORBIDDEN',
      error: '本機 Helper 尚未授權這個擴充功能。請重新執行最新版 Helper 安裝程式。'
    };
  }
  return { ok: false, error: message };
}

function nativeHostStatusResponse(response) {
  if (!response?.ok || versionAtLeast(response.version, MIN_NATIVE_HOST_VERSION)) return response;
  return nativeHostUpdateResponse(response.version);
}

function nativeHostUpdateResponse(currentVersion) {
  const displayedVersion = currentVersion || '未知';
  return {
    ok: false,
    code: 'NATIVE_HOST_UPDATE_REQUIRED',
    error: `本機 Helper 版本過舊（目前 ${displayedVersion}，需要 ${MIN_NATIVE_HOST_VERSION} 以上）。請重新執行最新版 Helper 安裝程式，再重新載入擴充功能。`,
    currentVersion: displayedVersion,
    requiredVersion: MIN_NATIVE_HOST_VERSION
  };
}

function versionAtLeast(currentVersion, requiredVersion) {
  const current = String(currentVersion || '').split('.').map(Number);
  const required = String(requiredVersion || '').split('.').map(Number);
  if (current.some(part => !Number.isInteger(part))) return false;
  for (let index = 0; index < Math.max(current.length, required.length); index++) {
    const difference = (current[index] || 0) - (required[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function providerDependencies() {
  return {
    nativeCheck: async () => nativeHostStatusResponse(await sendNativeRequest({ action: 'ping' })),
    restCheck: async (settings) => {
      if (!settings.apiKey) return { ok: false, error: '尚未設定 API Key' };
      const response = await fetch(`${apiBase(settings.port || 27123)}/`, {
        headers: { 'Authorization': `Bearer ${settings.apiKey}` }
      });
      return { ok: response.ok, status: response.status };
    },
    notesCheck: async (settings) => sendNativeRequest({
      action: 'notesExistsLocation',
      accountId: settings.accountId,
      folderId: settings.folderId
    }),
    saveMarkdownDraft,
    saveMarkdownPublished,
    findMarkdownBySource: async (data, settings) => {
      const index = await vaultNoteIndex(settings.basePath || DEFAULT_BASE_PATH, settings);
      const identity = postIdentity(data.url);
      const entry = index?.entries?.find(item => postIdentity(item.sourceUrl) === identity);
      return entry?.name
        ? SP2OStorage.fileRef(settings.storageProvider, `${settings.basePath || DEFAULT_BASE_PATH}/${entry.name}`, noteBasename(entry.name), data.url)
        : null;
    },
    fileExists: (ref, settings) => vaultFileExists(ref.path, settings),
    deleteFile: (ref, settings, strict) => deleteVaultFile(ref.path, settings, strict),
    nativeOpen: async (ref) => sendNativeRequest({ action: 'open', path: ref.path }),
    openObsidian: async (ref) => {
      await chrome.tabs.create({ url: 'obsidian://open?file=' + encodeURIComponent(ref.path) });
      return { ok: true };
    },
    restArchive: (cutoff, settings) => archiveRestSocialPosts(settings, cutoff),
    nativeArchive: (cutoff, settings) => sendNativeRequest({
      action: 'archiveSocialPosts',
      path: normalizeVaultPath(settings.basePath || DEFAULT_BASE_PATH),
      olderThan: cutoff
    }),
    saveLocalDraft,
    saveNotesPublished,
    findNotesBySource: async (data, settings) => {
      const response = await sendNativeRequest({
        action: 'notesFind',
        accountId: settings.accountId,
        folderId: settings.folderId,
        externalKey: postIdentity(data.url) || data.url
      });
      return response.noteId
        ? SP2OStorage.notesRef(response.noteId, response.title, response.externalKey)
        : null;
    },
    notesExists: async (ref, settings) => {
      const response = await sendNativeRequest({
        action: 'notesExists',
        accountId: settings.accountId,
        noteId: ref.noteId,
        externalKey: ref.externalKey
      });
      return response.exists === true;
    },
    notesDelete: (ref, settings) => sendNativeRequest({
      action: 'notesDelete',
      accountId: settings.accountId,
      noteId: ref.noteId,
      externalKey: ref.externalKey
    }),
    notesOpen: (ref, settings) => sendNativeRequest({
      action: 'notesShow',
      accountId: settings.accountId,
      noteId: ref.noteId,
      externalKey: ref.externalKey
    }),
    scanFilePublished,
    mergeFileDuplicateGroup,
    scanNotesPublished,
    mergeNotesDuplicateGroup
  };
}

async function getStorageStatus() {
  const settings = await getStorageSettings();
  const provider = getProvider(settings);
  const status = await provider.check(settings);
  return { ...status, provider: provider.id, capabilities: provider.capabilities };
}

async function openStorageActivity(ref) {
  const normalized = SP2OStorage.normalizeRef(ref, ref?.provider);
  if (!normalized) throw new Error('找不到要開啟的項目');
  const settings = await settingsForProvider(normalized.provider);
  await getProvider(settings).open(normalized, settings);
  return { ok: true };
}

async function settingsForProvider(providerId) {
  await ensureStorageSchema();
  const stored = await chrome.storage.local.get(STORAGE_SETTING_KEYS);
  const key = providerId === SP2OStorage.PROVIDERS.OBSIDIAN_REST
    ? 'obsidianRestSettings'
    : providerId === SP2OStorage.PROVIDERS.APPLE_NOTES
      ? 'appleNotesSettings'
      : 'markdownFolderSettings';
  return { ...(stored[key] || {}), storageProvider: providerId };
}

async function saveMarkdownDraft(data, previousRef, settings) {
  const filename = `_草稿_${platformDisplayName(data.platform, true)}.md`;
  const path = `${settings.basePath || DEFAULT_BASE_PATH}/${filename}`;
  await saveVaultFile(generateDraftMarkdown(data), path, settings, 'text/markdown');
  return SP2OStorage.fileRef(settings.storageProvider, path, filename, `draft:${data.platform}`);
}

async function saveMarkdownPublished(data, context, settings) {
  if (typeof data.rawMarkdown === 'string') {
    await saveVaultFile(data.rawMarkdown, context.fullPath, settings, 'text/markdown');
    return {
      savedMedia: 0,
      failedMedia: 0,
      merged: false,
      ref: SP2OStorage.fileRef(settings.storageProvider, context.fullPath, context.filename, context.ref?.externalKey)
    };
  }
  if (context.crossPlatformExisting) {
    const current = await parseMarkdownPostRecord(context.existingMarkdown, context.ref);
    if (!current || current.fingerprint !== context.fingerprint) {
      throw new Error('既有筆記內容已變更，跨平台合併已取消');
    }
    const mediaResults = await mergedMediaResults(data, current, [], settings);
    const markdown = mergeCrossPlatformMarkdown(
      context.existingMarkdown,
      context.fingerprint,
      context.sources,
      [],
      mediaResults
    );
    await saveVaultFile(markdown, context.fullPath, settings, 'text/markdown', vaultFileTime(current.createdAt));
    const verified = await parseMarkdownPostRecord(await readVaultFile(context.fullPath, settings), context.ref);
    if (!verified || verified.fingerprint !== context.fingerprint
      || !context.sources.every(source => verified.sources.some(item => item.externalKey === source.externalKey))) {
      throw new Error('跨平台合併讀回驗證失敗');
    }
    return {
      savedMedia: mediaResults.filter(item => !item.failed).length,
      failedMedia: mediaResults.filter(item => item.failed).length,
      merged: true,
      ref: context.ref
    };
  }
  const result = context.appendExisting
    ? await appendPostBundle(
      data, context.fullPath, context.filename, settings,
      context.existingMarkdown, context.rootTimestamp, context.mergeUrls
    )
    : await savePostBundle(data, context.fullPath, context.filename, settings, context);
  return {
    ...result,
    merged: !!context.merged,
    ref: SP2OStorage.fileRef(
      settings.storageProvider,
      context.fullPath,
      context.filename,
      context.mergeUrls?.[0] || data.url
    )
  };
}

async function saveLocalDraft(data) {
  const key = `draftSnapshot_${data.platform}`;
  await chrome.storage.local.set({
    [key]: {
      data,
      savedAt: data.timestamp,
      draftSessionId: data.draftSessionId || null
    }
  });
  return null;
}

function enqueue(platform, task) {
  const key = platform || 'default';
  taskChains[key] = (taskChains[key] || Promise.resolve()).then(task).catch(() => {});
  return taskChains[key];
}

function scheduleDraftSave(data, tabId) {
  const key = data.platform || 'default';
  const state = draftSaveStates[key] || (draftSaveStates[key] = {
    latest: null,
    running: null
  });
  state.latest = { data, tabId };
  if (state.running) return state.running;

  state.running = enqueue(key, async () => {
    const latest = state.latest;
    state.latest = null;
    if (latest) await handleSaveDraft(latest.data, latest.tabId);
  }).finally(() => {
    state.running = null;
    // 執行期間若又收到草稿，只排一個最新快照。此時若 PUBLISH_DRAFT
    // 已進 taskChains，新快照會排在它後面並由 lastPublishTimestamp 丟棄。
    if (state.latest) scheduleDraftSave(state.latest.data, state.latest.tabId);
  });

  return state.running;
}

function discardPendingDraftSave(data) {
  const key = data.platform || 'default';
  const state = draftSaveStates[key];
  if (!state?.latest) return;
  const pendingSession = state.latest.data?.draftSessionId;
  if (!data.draftSessionId || !pendingSession || pendingSession === data.draftSessionId) {
    state.latest = null;
  }
}

function publishedDraftSessionStorageKey(platform) {
  return 'publishedDraftSession_' + (platform || 'default');
}

async function rememberPublishedDraftSession(platform, sessionId, tabId) {
  if (!sessionId) return;
  const key = platform || 'default';
  const now = Date.now();
  const sessions = publishedDraftSessions[key] || (publishedDraftSessions[key] = new Map());
  sessions.set(sessionId, now);
  if (key === 'x' && tabId != null) {
    publishedDraftTabSettles[key] = { tabId, publishedAt: now };
  }
  publishedDraftSessionsLoaded[key] = true;
  for (const [id, publishedAt] of sessions) {
    if (now - publishedAt > PUBLISHED_DRAFT_SESSION_TTL_MS) sessions.delete(id);
  }
  try {
    await chrome.storage.local.set({
      [publishedDraftSessionStorageKey(platform)]: { id: sessionId, publishedAt: now, tabId }
    });
  } catch (error) {
    // 記憶體 guard 仍有效；不能因輔助狀態寫入失敗，讓正式檔被誤報失敗並留下草稿。
    console.log('[Social Post to Obsidian] Draft session persistence skipped:', error.message);
  }
}

function wasTabRecentlyPublished(key, tabId, now = Date.now()) {
  const recent = publishedDraftTabSettles[key];
  return key === 'x'
    && tabId != null
    && recent?.tabId === tabId
    && now - recent.publishedAt <= POST_PUBLISH_SETTLE_MS;
}

async function wasDraftSessionPublished(platform, sessionId, tabId) {
  if (!sessionId) return false;
  const key = platform || 'default';
  if (wasTabRecentlyPublished(key, tabId)) return true;
  const sessions = publishedDraftSessions[key] || (publishedDraftSessions[key] = new Map());
  const publishedAt = sessions?.get(sessionId);
  if (publishedAt) {
    if (Date.now() - publishedAt <= PUBLISHED_DRAFT_SESSION_TTL_MS) return true;
    sessions.delete(sessionId);
  }
  if (publishedDraftSessionsLoaded[key]) return false;

  publishedDraftSessionsLoaded[key] = true;
  const storageKey = publishedDraftSessionStorageKey(platform);
  let stored;
  try {
    stored = await chrome.storage.local.get(storageKey);
  } catch (error) {
    console.log('[Social Post to Obsidian] Draft session lookup skipped:', error.message);
    return false;
  }
  const persisted = stored[storageKey];
  if (!persisted?.id || Date.now() - Number(persisted.publishedAt || 0) > PUBLISHED_DRAFT_SESSION_TTL_MS) {
    return false;
  }
  const persistedAt = Number(persisted.publishedAt);
  sessions.set(persisted.id, persistedAt);
  if (persisted.tabId != null) {
    publishedDraftTabSettles[key] = { tabId: persisted.tabId, publishedAt: persistedAt };
  }
  return persisted.id === sessionId || wasTabRecentlyPublished(key, tabId);
}

function xSenderInfo(sender) {
  try {
    const url = new URL(sender?.url || '');
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) return null;
    return {
      tabId: sender?.tab?.id,
      pathname: url.pathname
    };
  } catch (e) {
    return null;
  }
}

function isOwnRepliesPath(pathname, author) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  return parts[0]?.toLowerCase() === author.toLowerCase() && parts[1] === 'with_replies';
}

async function closeXBackfillTab(tabId) {
  if (tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    // 分頁可能已被使用者關閉；清理 storage 即可
  }
}

async function clearXBackfillJob(job, completed) {
  await chrome.storage.local.remove(X_BACKFILL_JOB_KEY);
  chrome.alarms.clear(X_BACKFILL_TIMEOUT_ALARM);
  if (completed) {
    await chrome.storage.local.set({ [X_BACKFILL_LAST_KEY]: Date.now() });
  }
  await closeXBackfillTab(job?.tabId);
}

async function cancelXBackfillScan(sender) {
  const source = xSenderInfo(sender);
  if (!source || source.tabId == null) {
    return { ok: false, canceled: false, error: '無法確認 X 分頁' };
  }

  const stored = await chrome.storage.local.get(X_BACKFILL_JOB_KEY);
  const job = stored[X_BACKFILL_JOB_KEY];
  if (!job || job.requesterTabId !== source.tabId) {
    return { ok: true, canceled: false };
  }

  await clearXBackfillJob(job, false);
  console.log('[Social Post to Obsidian] 使用者開始撰寫，已暫停 X 背景補存掃描');
  return { ok: true, canceled: true };
}

// 一般 x.com 頁面沒有 UserTweetsAndReplies 的已簽章請求。建立非作用中的本人
// replies 分頁，讓 X 自己產生合法請求；結果再傳回原分頁供使用者確認。
async function ensureXBackfillScan(author, sender) {
  const source = xSenderInfo(sender);
  const normalizedAuthor = String(author || '').replace(/^@/, '');
  if (!source || source.tabId == null || !/^[A-Za-z0-9_]{1,15}$/.test(normalizedAuthor)) {
    return { ok: false, scanTab: false, error: '無法確認 X 登入帳號' };
  }

  const stored = await chrome.storage.local.get([X_BACKFILL_JOB_KEY, X_BACKFILL_LAST_KEY]);
  const job = stored[X_BACKFILL_JOB_KEY];
  if (job && Date.now() - Number(job.startedAt || 0) < X_BACKFILL_TIMEOUT_MS) {
    return {
      ok: true,
      scanTab: job.tabId === source.tabId,
      inProgress: true,
      opened: false
    };
  }
  if (job) await clearXBackfillJob(job, false);

  // 使用者本來就在自己的 replies 頁時直接沿用當前分頁，不另開一頁。
  if (isOwnRepliesPath(source.pathname, normalizedAuthor)) {
    return { ok: true, scanTab: false, inProgress: false, opened: false };
  }

  const lastCompletedAt = Number(stored[X_BACKFILL_LAST_KEY] || 0);
  if (Date.now() - lastCompletedAt < X_BACKFILL_COOLDOWN_MS) {
    return { ok: true, scanTab: false, inProgress: false, opened: false, cooldown: true };
  }

  const tab = await chrome.tabs.create({
    url: `https://x.com/${encodeURIComponent(normalizedAuthor)}/with_replies`,
    active: false
  });
  if (tab?.id == null) throw new Error('無法建立 X 補存掃描分頁');

  const newJob = {
    tabId: tab.id,
    requesterTabId: source.tabId,
    author: normalizedAuthor,
    startedAt: Date.now()
  };
  await chrome.storage.local.set({ [X_BACKFILL_JOB_KEY]: newJob });
  chrome.alarms.create(X_BACKFILL_TIMEOUT_ALARM, { when: Date.now() + X_BACKFILL_TIMEOUT_MS });
  console.log('[Social Post to Obsidian] 已啟動 X 背景補存掃描');
  return { ok: true, scanTab: false, inProgress: true, opened: true };
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(false);
      return;
    }
    chrome.tabs.sendMessage(tabId, message, () => {
      const delivered = !chrome.runtime.lastError;
      resolve(delivered);
    });
  });
}

async function relayXBackfillResults(posts, sender) {
  const source = xSenderInfo(sender);
  const stored = await chrome.storage.local.get(X_BACKFILL_JOB_KEY);
  const job = stored[X_BACKFILL_JOB_KEY];
  if (!source || !job || source.tabId !== job.tabId) {
    return { ok: true, relayed: false };
  }

  const candidates = Array.isArray(posts) ? posts.slice(0, 100) : [];
  const delivered = await sendTabMessage(job.requesterTabId, {
    type: 'X_BACKFILL_RESULTS',
    posts: candidates
  });
  await clearXBackfillJob(job, delivered);
  console.log('[Social Post to Obsidian] X 背景補存掃描完成:', candidates.length);
  return { ok: true, relayed: delivered };
}

async function startNativeMaintenance() {
  chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 15 });
  const settings = await getStorageSettings();
  await cleanupEmptyMediaFolders(settings);
}

function startArchiveMaintenance() {
  chrome.alarms.clear(LEGACY_ARCHIVE_ALARM);
  chrome.alarms.get(ARCHIVE_ALARM, (alarm) => {
    void chrome.runtime.lastError;
    if (!alarm || alarm.periodInMinutes !== ARCHIVE_ALARM_PERIOD_MINUTES) {
      chrome.alarms.create(ARCHIVE_ALARM, {
        delayInMinutes: ARCHIVE_ALARM_DELAY_MINUTES,
        periodInMinutes: ARCHIVE_ALARM_PERIOD_MINUTES
      });
    }
  });
}

function stopArchiveMaintenance() {
  chrome.alarms.clear(ARCHIVE_ALARM);
  chrome.alarms.clear(LEGACY_ARCHIVE_ALARM);
}

// 每日封存排程只跟著目的地的封存能力走；SW 啟動、儲存設定與 alarm 觸發共用同一判斷。
function syncArchiveMaintenance(settings) {
  if (getProvider(settings).capabilities.archive) startArchiveMaintenance();
  else stopArchiveMaintenance();
}

function archiveFrontmatterValue(markdown, key) {
  const frontmatter = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s.exec(String(markdown || ''))?.[1];
  if (!frontmatter) return '';
  const prefix = `${key}:`;
  const line = frontmatter.split(/\r?\n/).find(item => item.startsWith(prefix));
  if (!line) return '';
  const value = line.slice(prefix.length).trim();
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function archivePostType(markdown, legacyType = '') {
  if (archiveFrontmatterValue(markdown, 'status') === 'draft') return '';
  const source = archiveFrontmatterValue(markdown, 'source');
  if (!['x', 'threads'].includes(source)) return legacyType;

  const explicitType = archiveFrontmatterValue(markdown, 'post_type');
  if (ARCHIVE_POST_FOLDERS[explicitType]) return explicitType;
  if (Number(archiveFrontmatterValue(markdown, 'thread_count')) > 1) return 'thread';
  const sourceAuthor = xAuthorFromStatusUrl(archiveFrontmatterValue(markdown, 'source_url'));
  const replyAuthor = xAuthorFromStatusUrl(archiveFrontmatterValue(markdown, 'reply_to'));
  if (sourceAuthor && sourceAuthor === replyAuthor) return 'thread';
  if (archiveFrontmatterValue(markdown, 'quoted_url') || archiveFrontmatterValue(markdown, 'quoted_from')) {
    return 'quote';
  }
  if (archiveFrontmatterValue(markdown, 'reply_to')) return 'reply';
  return 'post';
}

function archivePostTimestamp(markdown, filename) {
  const created = String(archiveFrontmatterValue(markdown, 'created') || '');
  const value = created || String(filename || '').replace(
    /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_.*/,
    '$1 $2:$3'
  );
  const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (local) {
    return new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] || 0)
    ).getTime();
  }
  return Date.parse(value);
}

async function listRestDirectory(directory, settings) {
  let response;
  try {
    response = await fetch(
      `${apiBase(settings.port || 27123)}/vault/${encodeURIComponent(directory)}/`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${settings.apiKey}` } }
    );
  } catch (error) {
    error.isObsidianConnectionError = true;
    throw error;
  }
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`列出 Vault 資料夾失敗：HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.files) ? body.files.map(String) : [];
}

function resolveArchiveLink(sourceDirectory, link) {
  const parts = String(link).startsWith('/')
    ? []
    : normalizeVaultPath(sourceDirectory).split('/').filter(Boolean);
  for (const part of String(link).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function rewriteArchivedLinks(markdown, sourceDirectory, targetDirectory) {
  return String(markdown).replace(/(!\[[^\]]*\]\(<)([^>]+)(>\))/g, (match, prefix, link, suffix) => {
    if (/^(?:https?:|data:)/i.test(link)) return match;
    const target = resolveArchiveLink(sourceDirectory, link);
    return `${prefix}${relativeVaultPath(targetDirectory, target)}${suffix}`;
  });
}

async function archiveRestSocialPosts(settings, cutoff) {
  const cutoffTimestamp = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTimestamp)) throw new Error('封存日期格式無效');
  const basePath = normalizeVaultPath(settings.basePath || DEFAULT_BASE_PATH);
  const sourceDirectories = [
    { path: basePath, legacyType: '' },
    ...Object.entries(ARCHIVE_POST_FOLDERS).map(([legacyType, folder]) => ({
      path: `${basePath}/${folder}`,
      legacyType
    }))
  ];
  const moved = [];
  const skipped = [];

  for (const directory of sourceDirectories) {
    const names = await listRestDirectory(directory.path, settings);
    for (const name of names.filter(item => item.endsWith('.md'))) {
      const sourcePath = `${directory.path}/${name}`;
      const markdown = await readVaultFile(sourcePath, settings);
      const postType = archivePostType(markdown, directory.legacyType);
      const createdAt = archivePostTimestamp(markdown, name);
      if (!postType || !Number.isFinite(createdAt) || createdAt >= cutoffTimestamp) continue;

      const targetPath = `${basePath}/Archive/${ARCHIVE_POST_FOLDERS[postType]}/${name}`;
      if (await vaultFileExists(targetPath, settings)) {
        skipped.push({ path: sourcePath, reason: 'target_exists' });
        continue;
      }

      const updated = rewriteArchivedLinks(
        markdown,
        directory.path,
        `${basePath}/Archive/${ARCHIVE_POST_FOLDERS[postType]}`
      );
      await saveVaultFile(updated, targetPath, settings, 'text/markdown');
      try {
        await deleteRestVaultFile(sourcePath, settings.apiKey, settings.port || 27123, true);
      } catch (error) {
        await deleteRestVaultFile(targetPath, settings.apiKey, settings.port || 27123, true).catch(() => {});
        throw error;
      }
      moved.push({ from: sourcePath, to: targetPath });
    }
  }

  return { ok: true, moved, skipped };
}

async function archiveOldSocialPosts(settings, cutoff = new Date(Date.now() - ARCHIVE_AGE_MS).toISOString()) {
  const provider = getProvider(settings);
  if (!provider.capabilities.archive) return 0;
  const response = await provider.archive(cutoff, settings);
  const moved = Array.isArray(response.moved) ? response.moved : [];
  if (!moved.length) {
    const skipped = Array.isArray(response.skipped) ? response.skipped.length : 0;
    console.log(`[Social Post to Obsidian] Obsidian 封存檢查完成：移動 0 筆，略過 ${skipped} 筆`);
    return 0;
  }

  const movedPaths = new Map(moved.map(item => [item.from, item.to]));
  const stored = await chrome.storage.local.get(['recentSaves', THREAD_CONTEXT_KEY]);
  const recentSaves = (stored.recentSaves || []).map((item) => (
    movedPaths.has(item.ref?.path)
      ? { ...item, ref: { ...item.ref, path: movedPaths.get(item.ref.path) } }
      : item
  ));
  const recentThreadContexts = (stored[THREAD_CONTEXT_KEY] || []).map((item) => (
    movedPaths.has(item.ref?.path)
      ? { ...item, ref: { ...item.ref, path: movedPaths.get(item.ref.path) } }
      : item
  ));
  await chrome.storage.local.set({ recentSaves, [THREAD_CONTEXT_KEY]: recentThreadContexts });
  await mutateContentDedupeIndex((index) => Object.fromEntries(
    Object.entries(index).map(([scope, fingerprints]) => [
      scope,
      Object.fromEntries(Object.entries(fingerprints || {}).map(([fingerprint, entries]) => [
        fingerprint,
        (entries || []).map((entry) => (
          movedPaths.has(entry.ref?.path)
            ? { ...entry, ref: { ...entry.ref, path: movedPaths.get(entry.ref.path) } }
            : entry
        ))
      ]))
    ])
  ));
  console.log('[Social Post to Obsidian] 已歸檔超過 7 天的社群貼文:', moved.length);
  return moved.length;
}

async function chooseNativeVault() {
  await ensureStorageSchema();
  const response = await sendNativeRequest({ action: 'chooseFolder' });
  const stored = await chrome.storage.local.get('markdownFolderSettings');
  await chrome.storage.local.set({
    storageProvider: SP2OStorage.PROVIDERS.MARKDOWN_FOLDER,
    markdownFolderSettings: {
      ...(stored.markdownFolderSettings || {}),
      folderName: response.folderName,
      isObsidianVault: response.isObsidianVault === true
    }
  });
  await startNativeMaintenance();
  return response;
}

// 處理草稿存檔
async function handleSaveDraft(data, tabId) {
  try {
    if (await wasDraftSessionPublished(data.platform, data.draftSessionId, tabId)) {
      console.log('[Social Post to Obsidian] 忽略已發佈 session 的遲到草稿');
      return;
    }

    // 發佈後才送達的舊草稿直接丟棄，避免已刪除的草稿檔又被寫回
    const publishedAt = lastPublishTimestamp[data.platform];
    if (publishedAt && data.timestamp <= publishedAt) {
      console.log('[Social Post to Obsidian] 忽略發佈前的舊草稿');
      return;
    }

    const settings = await getStorageSettings();
    validateProviderSettings(settings);
    const provider = getProvider(settings);
    const previous = (await chrome.storage.local.get('draftStatus_' + data.platform))['draftStatus_' + data.platform];
    const ref = await provider.saveDraft(data, previous?.ref, settings);
    const filename = ref?.title || `${platformDisplayName(data.platform)} 草稿`;

    console.log('[Social Post to Obsidian] Draft saved:', filename);
    sendDraftStatus(tabId, true, `草稿已暫存 ${formatDateTime(data.timestamp).slice(-5)}`);

    // 記錄草稿狀態供 popup 顯示（每平台一個 key，避免共用物件的讀寫競態）
    await chrome.storage.local.set({
      ['draftStatus_' + data.platform]: {
        filename,
        ref,
        provider: provider.id,
        savedAt: data.timestamp,
        draftSessionId: data.draftSessionId || null,
        preview: createPostPreview(data)
      }
    });
  } catch (error) {
    // 草稿失敗不跳系統通知（打字中會很吵）；正式貼文有離線佇列保底
    if (isConnectionError(error) || error.isNativeHostError) {
      // 用 log 而非 warn：warn 會被收進擴充功能錯誤頁，暫時無法寫入是預期情況
      console.log('[Social Post to Obsidian] Draft save skipped (Vault 無法寫入)');
      sendDraftStatus(tabId, false, (error.isNativeHostError || error.isVaultWriteError)
        ? '儲存目的地尚未授權，草稿未暫存'
        : '儲存目的地未連線，草稿未暫存');
    } else {
      console.error('[Social Post to Obsidian] Draft save failed:', error);
      sendDraftStatus(tabId, false, '草稿暫存失敗');
    }
  }
}

// 草稿狀態只回報到頁面內的狀態列，不用系統通知（分頁不在就靜默略過）
function sendDraftStatus(tabId, ok, text) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'DRAFT_RESULT', ok, text }, () => {
    void chrome.runtime.lastError;
  });
}

// 處理發佈（存正式檔案 + 刪除草稿）
async function handlePublishDraft(data, tabId) {
  try {
    const settings = await getStorageSettings();
    validateProviderSettings(settings);

    // 1. 先存正式檔案；失敗（且未進離線佇列）時保留草稿檔與 draftStatus，內容不遺失
    const saveOutcome = await withCrossPostLock(data, settings, async (fingerprint) => {
      const prepared = await prepareStoragePost(data, settings, fingerprint);
      return saveWithQueueFallback(
        prepared.fullPath,
        prepared.filename,
        prepared.data,
        settings,
        tabId,
        prepared
      );
    });

    // 發佈已受理（含進入離線佇列）後，遲到的舊草稿才可丟棄
    const acceptedAt = new Date().toISOString();
    lastPublishTimestamp[data.platform] = acceptedAt;
    await rememberPublishedDraftSession(data.platform, data.draftSessionId, tabId);

    // 2. 刪除草稿；刪除失敗時保留 draftStatus，讓 popup 清單與 Vault 檔案維持一致
    const draftStatusKey = 'draftStatus_' + data.platform;
    const stored = await chrome.storage.local.get(draftStatusKey);
    const trackedDraft = stored[draftStatusKey];
    const cleanupMatchesSession = !data.draftSessionId
      || !trackedDraft?.draftSessionId
      || trackedDraft.draftSessionId === data.draftSessionId;
    try {
      const keepLocalNotesDraft = settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES
        && saveOutcome?.queued;
      if (cleanupMatchesSession && !keepLocalNotesDraft) {
        if (getProvider(settings).capabilities.remoteDraft && trackedDraft?.ref) {
          await getProvider(settings).delete(trackedDraft.ref, settings, true);
        }
        await chrome.storage.local.remove(`draftSnapshot_${data.platform}`);
        await chrome.storage.local.remove(draftStatusKey);
      } else if (!keepLocalNotesDraft) {
        console.log('[Social Post to Obsidian] 保留另一個 composer session 的草稿');
      } else {
        console.log('[Social Post to Obsidian] Apple 備忘錄尚未接受貼文，保留本機草稿快照');
      }
    } catch (error) {
      console.log('[Social Post to Obsidian] Draft cleanup failed:', error.message);
    }
    return true;
  } catch (error) {
    console.error('[Social Post to Obsidian] Publish failed:', error);
    notifyResult(tabId, false, error.message);
    return false;
  }
}

// 存檔；目前寫入方式不可用時加入離線佇列，稍後自動補存
async function saveWithQueueFallback(fullPath, filename, data, settings, tabId, options = {}) {
  const silent = !!options.silent;
  let result;
  let merged = options.merged;
  let mergeFailed = false;
  let targetPath = fullPath;
  let targetFilename = filename;
  const provider = getProvider(settings);

  try {
    result = await provider.savePublished(data, { ...options, fullPath, filename }, settings);
  } catch (error) {
    if (isConnectionError(error)) {
      await enqueueOffline({
        provider: provider.id,
        data,
        ref: options.ref || (fullPath
          ? SP2OStorage.fileRef(provider.id, fullPath, filename, data.url)
          : null),
        filename,
        platform: data.platform, url: data.url,
        mergeSegments: options.mergeSegments,
        mergeUrls: options.mergeUrls,
        appendExisting: options.appendExisting,
        existingMarkdown: options.existingMarkdown,
        rootTimestamp: options.rootTimestamp,
        crossPlatformExisting: options.crossPlatformExisting,
        fingerprint: options.fingerprint,
        sources: options.sources,
        canonicalRecord: options.canonicalRecord
      });
      const destination = provider.id === SP2OStorage.PROVIDERS.OBSIDIAN_REST
        ? 'Obsidian'
        : provider.id === SP2OStorage.PROVIDERS.APPLE_NOTES ? 'Apple 備忘錄' : '本機 Helper';
      notifyResult(tabId, false, `${destination} 無法寫入，已加入待存佇列，恢復後自動補存`, silent);
      return { queued: true };
    }
    // 合併失敗（母筆記被手動編輯到無法安全接續）不可讓整篇貼文消失：
    // 退回一般建檔流程另存新檔，並在新筆記標註母筆記，讓使用者能手動接回。
    if (!options.appendExisting || provider.id === SP2OStorage.PROVIDERS.APPLE_NOTES) throw error;

    console.log('[Social Post to Obsidian] Merge failed, saving separately:', error.message);
    mergeFailed = true;
    merged = false;
    const location = publishedPostLocation(data, settings.basePath || DEFAULT_BASE_PATH);
    targetPath = location.fullPath;
    targetFilename = location.filename;
    result = await provider.savePublished(data, {
      fullPath: targetPath,
      filename: targetFilename,
      threadRoot: options.threadRoot || noteBasename(fullPath)
    }, settings);
  }

  if (provider.id === SP2OStorage.PROVIDERS.APPLE_NOTES && options.merged && result.merged === false) {
    merged = false;
    options = {
      ...options,
      merged: false,
      mergeSegments: [data],
      mergeUrls: publishedPostUrls(data),
      rootTimestamp: data.timestamp,
      ref: null
    };
  }

  // 另存新檔時不能沿用母筆記的合併狀態，否則下一則回覆會依母筆記的 URL 與時間
  // 再接到同一個壞掉的檔。清空後下面會退回這篇自己的 url／timestamp。
  if (mergeFailed) {
    options = {
      ...options,
      appendExisting: false,
      mergeUrls: null,
      rootTimestamp: null,
      mergeSegments: null
    };
  }
  fullPath = targetPath;
  filename = targetFilename;

  const savedRef = result.ref || SP2OStorage.fileRef(provider.id, fullPath, filename, data.url);

  await recordRecentSave({
    filename,
    ref: savedRef,
    platform: data.platform,
    platforms: [...new Set((options.sources || data.sources || [sourceForPost(data)])
      .map(source => source.platform))],
    sources: options.sources || data.sources,
    url: options.appendExisting ? (options.mergeUrls?.[0] || data.replyTo || data.url) : data.url,
    preview: createPostPreview(data),
    mergeSegments: options.appendExisting ? options.mergeSegments : (options.mergeSegments || [data]),
    mergeMode: options.appendExisting ? 'markdown' : '',
    rootTimestamp: options.rootTimestamp || options.mergeSegments?.[0]?.timestamp || data.timestamp,
    mergeUrls: options.mergeUrls || publishedPostUrls(data)
  });
  await recordContentDedupe(data, settings, savedRef, options.sources || data.sources, options.fingerprint || data.contentFingerprint);
  const mediaText = result.failedMedia > 0
    ? `（${result.failedMedia} 張圖片未同步）`
    : result.savedMedia > 0 ? `（${result.savedMedia} 張圖片）` : '';
  const action = mergeFailed ? '已另存新檔（無法合併）' : merged ? '已合併' : '已儲存';
  // 自動補存改由分頁端統一回報總數，這裡不逐則跳 toast；失敗才通知
  if (!silent) notifyResult(tabId, true, `${action}${mediaText}: ${filename}`);
  console.log('[Social Post to Obsidian] Published:', SP2OStorage.refKey(savedRef));
  return { queued: false, ref: savedRef };
}

function validateProviderSettings(settings) {
  if (settings.storageProvider === SP2OStorage.PROVIDERS.OBSIDIAN_REST && !settings.apiKey) {
    throw new Error('請先在擴充功能設定中輸入 Obsidian API Key');
  }
  if (settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES
    && (!settings.accountId || !settings.folderId)) {
    throw new Error('請先選擇 Apple 備忘錄的帳號與資料夾');
  }
}

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif'
};

// Write images before Markdown. Retries overwrite the same paths, so the operation is idempotent.
async function savePostBundle(data, fullPath, filename, settings, options = {}) {
  const mediaResults = await savePostMedia(data, fullPath, filename, settings, 0);
  const markdown = generateMarkdown(data, mediaResults, options.threadRoot);
  await saveVaultFile(markdown, fullPath, settings, 'text/markdown', vaultFileTime(data.timestamp));

  return mediaSaveSummary(mediaResults);
}

async function savePostMedia(data, fullPath, filename, settings, offset) {
  const media = Array.isArray(data.media) ? data.media.slice(0, 20) : [];
  const noteDirectory = fullPath.includes('/') ? fullPath.slice(0, fullPath.lastIndexOf('/')) : '';
  const mediaDirectory = normalizeVaultPath(settings.mediaPath || DEFAULT_MEDIA_PATH);
  const assetFolder = filename.replace(/\.md$/i, '');

  // 各張圖片互相獨立（檔名用固定 index），平行下載與寫入以縮短發文延遲
  const mediaResults = await Promise.all(media.map(async (item, index) => {
    try {
      const image = await downloadImage(item.url);
      const imageNumber = offset + index + 1;
      const imageName = `image-${String(imageNumber).padStart(2, '0')}.${image.extension}`;
      const vaultPath = `${mediaDirectory}/${assetFolder}/${imageName}`;

      await saveVaultFile(
        image.bytes,
        vaultPath,
        settings,
        image.contentType
      );
      return { path: relativeVaultPath(noteDirectory, vaultPath), alt: item.alt || `圖片 ${imageNumber}` };
    } catch (error) {
      // Propagate Vault errors for queue handling, but keep the note when a remote image fails.
      if (error.isObsidianApiError || error.isVaultWriteError) throw error;
      console.log('[Social Post to Obsidian] Media download skipped:', index + 1, error.message);
      return { url: item.url, alt: item.alt || `圖片 ${offset + index + 1}`, failed: true };
    }
  }));

  return mediaResults;
}

function mediaSaveSummary(mediaResults) {
  return {
    savedMedia: mediaResults.filter(item => !item.failed).length,
    failedMedia: mediaResults.filter(item => item.failed).length
  };
}

async function appendPostBundle(data, fullPath, filename, settings, existingMarkdown, rootTimestamp, expectedUrls) {
  const imageCount = (String(existingMarkdown || '').match(/^!\[[^\n]*\]\(<[^>]+>\)$/gm) || []).length;
  const mediaResults = await savePostMedia(data, fullPath, filename, settings, imageCount);
  const markdown = appendPostToMarkdown(existingMarkdown, data, mediaResults, expectedUrls);
  await saveVaultFile(markdown, fullPath, settings, 'text/markdown', vaultFileTime(rootTimestamp));
  return mediaSaveSummary(mediaResults);
}

// 貼文時間 → 檔案修改時間（Unix 秒）。時間無法解析時回傳 null，寫入端會沿用當下時間。
function vaultFileTime(timestamp) {
  const date = new Date(timestamp);
  return isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

function normalizeVaultPath(path) {
  return String(path || '').split('/').filter(Boolean).join('/');
}

async function cleanupEmptyMediaFolders(settings) {
  if (resolveStorageMode(settings) !== 'native') return 0;
  try {
    const response = await sendNativeRequest({
      action: 'cleanEmptyMediaFolders',
      path: normalizeVaultPath(settings.mediaPath || DEFAULT_MEDIA_PATH)
    });
    const removed = response.removed || 0;
    if (removed > 0) {
      console.log('[Social Post to Obsidian] Removed empty media folders:', removed);
    }
    return removed;
  } catch (error) {
    console.log('[Social Post to Obsidian] Media folder cleanup skipped:', error.message);
    return 0;
  }
}

function relativeVaultPath(fromDirectory, targetPath) {
  const fromParts = normalizeVaultPath(fromDirectory).split('/').filter(Boolean);
  const targetParts = normalizeVaultPath(targetPath).split('/').filter(Boolean);
  let commonParts = 0;

  while (commonParts < fromParts.length
    && commonParts < targetParts.length
    && fromParts[commonParts] === targetParts[commonParts]) {
    commonParts++;
  }

  return [
    ...Array(fromParts.length - commonParts).fill('..'),
    ...targetParts.slice(commonParts)
  ].join('/');
}

async function downloadImage(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('圖片網址不是 HTTPS');

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`圖片下載失敗: HTTP ${response.status}`);

  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const pathExtension = parsedUrl.pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  const extension = IMAGE_EXTENSIONS[contentType]
    || (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(pathExtension) ? pathExtension.replace('jpeg', 'jpg') : '');
  if (!extension) throw new Error(`不支援的圖片格式: ${contentType || 'unknown'}`);

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('圖片內容為空');

  return {
    bytes: bytes,
    contentType: IMAGE_EXTENSIONS[contentType] ? contentType : `image/${extension === 'jpg' ? 'jpeg' : extension}`,
    extension: extension
  };
}

async function deleteRestVaultFile(filepath, apiKey, port, strict = false) {
  const url = `${apiBase(port)}/vault/${encodeURIComponent(filepath)}`;

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    // 404（草稿不存在）也沒關係，其他錯誤記下來
    if (!response.ok && response.status !== 404) {
      if (strict) throw new Error(`刪除 Vault 檔案失敗：HTTP ${response.status}`);
      console.warn('[Social Post to Obsidian] Vault file delete failed:', response.status);
    } else {
      console.log('[Social Post to Obsidian] Vault file deleted:', filepath);
    }
  } catch (error) {
    if (strict) throw error;
    console.log('[Social Post to Obsidian] Vault file delete skipped:', error.message);
  }
}

async function deleteVaultFile(filepath, settings, strict = false) {
  if (resolveStorageMode(settings) === 'native') {
    try {
      await sendNativeRequest({ action: 'remove', path: filepath });
      console.log('[Social Post to Obsidian] Vault file deleted:', filepath);
    } catch (error) {
      if (strict) throw error;
      console.log('[Social Post to Obsidian] Vault file delete skipped:', error.message);
    }
    return;
  }
  await deleteRestVaultFile(filepath, settings.apiKey, settings.port || 27123, strict);
}

async function readVaultFile(filepath, settings) {
  if (resolveStorageMode(settings) === 'native') {
    const response = await sendNativeRequest({ action: 'read', path: filepath });
    return String(response.data || '');
  }

  let response;
  try {
    response = await fetch(`${apiBase(settings.port || 27123)}/vault/${encodeURIComponent(filepath)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${settings.apiKey}` }
    });
  } catch (error) {
    error.isObsidianConnectionError = true;
    throw error;
  }
  if (!response.ok) throw new Error(`讀取 Vault 檔案失敗：HTTP ${response.status}`);
  return response.text();
}

async function clearAutoDrafts() {
  const stored = await chrome.storage.local.get(['draftStatus_x', 'draftStatus_threads']);
  const drafts = [
    { key: 'draftStatus_x', snapshotKey: 'draftSnapshot_x' },
    { key: 'draftStatus_threads', snapshotKey: 'draftSnapshot_threads' }
  ].filter(({ key }) => stored[key]);
  const errors = [];
  let cleared = 0;

  for (const draft of drafts) {
    try {
      const ref = stored[draft.key].ref;
      if (ref) {
        const settings = await settingsForProvider(ref.provider);
        const provider = getProvider(settings);
        if (provider.capabilities.remoteDraft) await provider.delete(ref, settings, true);
      }
      await chrome.storage.local.remove(draft.snapshotKey);
      await chrome.storage.local.remove(draft.key);
      cleared++;
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    ok: errors.length === 0,
    cleared,
    error: errors.length > 0 ? errors.join('；') : undefined
  };
}

async function vaultFileExists(filepath, settings) {
  if (resolveStorageMode(settings) === 'native') {
    const response = await sendNativeRequest({ action: 'exists', path: filepath });
    return response.exists === true;
  }

  let response;
  try {
    response = await fetch(`${apiBase(settings.port || 27123)}/vault/${encodeURIComponent(filepath)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${settings.apiKey}` }
    });
  } catch (error) {
    error.isObsidianConnectionError = true;
    throw error;
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`同步 Vault 狀態失敗：HTTP ${response.status}`);
  return true;
}

// 手機貼文補存的比對：算出每則候選貼文會寫到哪個檔名，回報 Vault 裡還沒有的那些。
// 只回報缺少的項目，不寫任何檔案——建檔仍須使用者在頁面上確認。
async function findMissingPosts(posts) {
  if (!Array.isArray(posts) || !posts.length) return { ok: true, missing: [] };

  const settings = await getStorageSettings();
  try { validateProviderSettings(settings); } catch (error) { return { ok: false, error: error.message }; }

  const basePath = settings.basePath || DEFAULT_BASE_PATH;
  const missing = [];
  const notesProvider = settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES;
  const existing = notesProvider ? null : await vaultNoteIndex(basePath, settings);

  for (const data of posts) {
    if (!data || !data.url || !data.timestamp) continue;
    try {
      let found = false;
      if (notesProvider) {
        found = !!(await getProvider(settings).findBySource(data, settings));
      } else if (existing) {
        found = existingNoteMatches(data, existing);
      } else {
        for (const filepath of candidateVaultPaths(data, basePath)) {
          if (await vaultFileExists(filepath, settings)) {
            found = true;
            break;
          }
        }
      }
      if (!found) missing.push(data.url);
    } catch (error) {
      // 查不到 Vault 狀態時視為已存在：寧可漏提示，也不要因為誤判而重複建檔
      console.log('[Social Post to Obsidian] Backfill check failed:', error.message);
    }
  }

  return { ok: true, missing: missing };
}

// 新版 Host 會連同 frontmatter source_url 回傳；優先用 status ID 精準比對，
// 才不會因 composer/API 的空白差異重複建檔，也不會把同分鐘的另一篇貼文誤判成已存。
// 舊 Host／REST 拿不到 frontmatter 時才退回同分鐘前綴，維持升級前的保守行為。
function existingNoteMatches(data, index) {
  const names = Array.isArray(index.names) ? index.names : [];
  const entries = Array.isArray(index.entries) ? index.entries : null;
  const candidates = new Set(candidateFilenames(data));

  if (entries) {
    const identity = postIdentity(data.url);
    if (identity && entries.some((entry) => postIdentity(entry.sourceUrl) === identity)) return true;
    if (entries.some((entry) => candidates.has(noteBasename(entry.name)))) return true;

    const prefix = notePrefix(data);
    const sameMinute = prefix
      ? entries.filter((entry) => noteBasename(entry.name).startsWith(prefix))
      : [];
    // 舊筆記或 8 秒 DOM fallback 可能沒有正式 status URL；遇到這種無法精準辨識的
    // 同分鐘筆記仍視為已存在，避免升級後立刻補出重複檔。
    if (sameMinute.some((entry) => !postIdentity(entry.sourceUrl))) return true;
    return false;
  }

  const prefix = notePrefix(data);
  return !!prefix && names.some((name) => noteBasename(name).startsWith(prefix));
}

function noteBasename(path) {
  return String(path || '').split('/').pop() || '';
}

// wikilink 用的筆記名：去掉副檔名，並移除會截斷 [[…]] 的字元
function noteStem(path) {
  return noteBasename(path).replace(/\.md$/i, '').replace(/[[\]|#^]/g, '');
}

function postIdentity(url) {
  const value = String(url || '');
  const x = value.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  if (x) return `x:${x[1]}`;
  const threads = value.match(/threads\.(?:com|net)\/@?[^/]+\/post\/([^/?#]+)/i);
  if (threads) return `threads:${threads[1]}`;
  return '';
}

function notePrefix(data) {
  const match = /^(\d{4}-\d{2}-\d{2}_\d{4}_)/.exec(generateFilename(data));
  return match ? match[1] : '';
}

// basePath 底下現有的筆記索引；取不到（例如 Host 不可用）時回傳 null，
// 呼叫端會退回逐檔比對，行為與加入這個機制之前相同。
async function vaultNoteIndex(basePath, settings) {
  try {
    if (resolveStorageMode(settings) === 'native') {
      const response = await sendNativeRequest({ action: 'list', path: basePath, recursive: true });
      if (!Array.isArray(response.names)) return null;
      return {
        names: response.names,
        // 舊版 Host 只有 names；null 代表必須走保守的檔名前綴相容判斷
        entries: Array.isArray(response.entries) ? response.entries : null
      };
    }
    const names = [];
    const directories = ['', ...Object.values(X_POST_CATEGORIES).map(category => category.folder)];
    for (const folder of directories) {
      const path = folder ? `${basePath}/${folder}` : basePath;
      const response = await fetch(
        `${apiBase(settings.port || 27123)}/vault/${encodeURIComponent(path)}/`,
        { method: 'GET', headers: { 'Authorization': `Bearer ${settings.apiKey}` } }
      );
      if (response.status === 404) continue;
      if (!response.ok) return null;
      const body = await response.json();
      if (!Array.isArray(body.files)) continue;
      body.files
        .filter(name => String(name).endsWith('.md'))
        .forEach(name => names.push(folder ? `${folder}/${name}` : name));
    }
    return { names, entries: null };
  } catch (error) {
    console.log('[Social Post to Obsidian] Vault listing unavailable:', error.message);
    return null;
  }
}

async function listRestMarkdownPaths(basePath, settings) {
  const pending = [{ path: normalizeVaultPath(basePath), depth: 0 }];
  const paths = [];
  while (pending.length) {
    const current = pending.shift();
    const names = await listRestDirectory(current.path, settings);
    for (const name of names) {
      const value = String(name || '');
      if (value.endsWith('/')) {
        if (current.depth < 8 && !/(?:^|\/)Drafts\/?$/i.test(`${current.path}/${value}`)) {
          pending.push({ path: `${current.path}/${value.replace(/\/$/, '')}`, depth: current.depth + 1 });
        }
      } else if (value.endsWith('.md')) {
        paths.push(`${current.path}/${value}`);
      }
    }
  }
  return paths;
}

async function scanFilePublished(settings) {
  const basePath = normalizeVaultPath(settings.basePath || DEFAULT_BASE_PATH);
  let paths;
  if (resolveStorageMode(settings) === 'native') {
    const response = await sendNativeRequest({ action: 'list', path: basePath, recursive: true });
    paths = (response.names || [])
      .filter(name => String(name).endsWith('.md') && !/(?:^|\/)Drafts\//i.test(String(name)))
      .map(name => `${basePath}/${name}`);
  } else {
    paths = await listRestMarkdownPaths(basePath, settings);
  }
  const records = [];
  const errors = [];
  for (const path of paths) {
    try {
      const ref = SP2OStorage.fileRef(settings.storageProvider, path, noteBasename(path), path);
      const record = await parseMarkdownPostRecord(await readVaultFile(path, settings), ref);
      if (record) records.push(record);
    } catch (error) {
      errors.push(`${noteBasename(path)}：${error.message}`);
    }
  }
  return { records, errors };
}

async function scanNotesPublished(settings) {
  const records = [];
  const errors = [];
  let cursor = 0;
  for (;;) {
    const response = await sendNativeRequest({
      action: 'notesListPosts',
      accountId: settings.accountId,
      folderId: settings.folderId,
      cursor,
      limit: 10
    });
    for (const entry of response.entries || []) {
      try {
        const record = await parseNotesPostRecord(entry, settings);
        if (record) records.push(record);
      } catch (error) {
        errors.push(`${entry.title || entry.noteId}：${error.message}`);
      }
    }
    if (response.nextCursor == null) break;
    cursor = Number(response.nextCursor);
  }
  return { records, errors };
}

function compareDuplicateRecord(left, right) {
  const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return Number.isFinite(time) && time !== 0
    ? time
    : SP2OStorage.refKey(left.ref).localeCompare(SP2OStorage.refKey(right.ref));
}

function duplicateGroupsForRecords(provider, records) {
  const byFingerprint = new Map();
  for (const record of records) {
    const list = byFingerprint.get(record.fingerprint) || [];
    list.push(record);
    byFingerprint.set(record.fingerprint, list);
  }
  const groups = [];
  for (const [fingerprint, matches] of byFingerprint) {
    const consumed = new Set();
    const mergedRecords = matches.filter(record => record.platforms.length > 1).sort(compareDuplicateRecord);
    for (const canonical of mergedRecords) {
      const sourceKeys = new Set(canonical.sources.map(source => source.externalKey));
      const leftovers = matches.filter(record => (
        record !== canonical
        && !consumed.has(record)
        && record.platforms.length === 1
        && record.sources.some(source => sourceKeys.has(source.externalKey))
      ));
      for (const duplicate of leftovers) {
        consumed.add(duplicate);
        groups.push({
          id: `${provider}:${fingerprint}:cleanup:${SP2OStorage.refKey(duplicate.ref)}`,
          provider,
          fingerprint,
          platforms: canonical.platforms,
          canonical,
          duplicates: [duplicate],
          blocked: false
        });
      }
    }
    const x = matches.filter(record => !consumed.has(record)
      && record.platforms.length === 1 && record.platforms[0] === 'x').sort(compareDuplicateRecord);
    const threads = matches.filter(record => !consumed.has(record)
      && record.platforms.length === 1 && record.platforms[0] === 'threads').sort(compareDuplicateRecord);
    for (let index = 0; index < Math.min(x.length, threads.length); index++) {
      const pair = [x[index], threads[index]].sort(compareDuplicateRecord);
      groups.push({
        id: `${provider}:${fingerprint}:${index}`,
        provider,
        fingerprint,
        platforms: ['x', 'threads'],
        canonical: pair[0],
        duplicates: pair.slice(1),
        blocked: false
      });
    }
  }
  return groups;
}

async function replaceDedupeScopeIndex(settings, records) {
  const scoped = {};
  for (const record of records) {
    const entries = scoped[record.fingerprint] || [];
    entries.push({
      ref: record.ref,
      title: record.title,
      createdAt: record.createdAt,
      platforms: record.platforms,
      sources: record.sources
    });
    scoped[record.fingerprint] = entries;
  }
  await mutateContentDedupeIndex(index => ({
    ...index,
    [dedupeScopeKey(settings)]: scoped
  }));
}

function duplicatePublicRecord(record) {
  return {
    ref: record.ref,
    title: record.title,
    createdAt: record.createdAt,
    platforms: record.platforms,
    sources: record.sources,
    imageCount: record.images?.length || 0,
    hasManualContent: (record.manualSections || []).length > 0
  };
}

function duplicatePublicGroup(group) {
  return {
    id: group.id,
    provider: group.provider,
    platforms: group.platforms,
    canonical: duplicatePublicRecord(group.canonical),
    duplicates: group.duplicates.map(duplicatePublicRecord),
    blocked: group.blocked,
    blockedReason: group.blockedReason
  };
}

async function scanDuplicatePosts() {
  await ensureStorageSchema();
  const stored = await chrome.storage.local.get(STORAGE_SETTING_KEYS);
  const configured = [
    [SP2OStorage.PROVIDERS.MARKDOWN_FOLDER, stored.markdownFolderSettings?.folderName],
    [SP2OStorage.PROVIDERS.OBSIDIAN_REST, stored.obsidianRestSettings?.apiKey],
    [SP2OStorage.PROVIDERS.APPLE_NOTES,
      stored.appleNotesSettings?.accountId && stored.appleNotesSettings?.folderId]
  ].filter(([, ready]) => ready);
  const providers = [];
  const groups = [];
  for (const [providerId] of configured) {
    try {
      const settings = await settingsForProvider(providerId);
      const result = await getProvider(settings).scanPublished(settings);
      const providerGroups = duplicateGroupsForRecords(providerId, result.records);
      groups.push(...providerGroups);
      await replaceDedupeScopeIndex(settings, result.records);
      providers.push({
        provider: providerId,
        ok: true,
        scanned: result.records.length,
        groups: providerGroups.length,
        warnings: result.errors
      });
    } catch (error) {
      providers.push({ provider: providerId, ok: false, error: error.message, groups: 0 });
    }
  }
  const scanId = `${Date.now()}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({
    [DUPLICATE_SCAN_SESSION_KEY]: {
      scanId,
      createdAt: new Date().toISOString(),
      providers,
      groups
    }
  });
  return { ok: true, scanId, providers, groups: groups.map(duplicatePublicGroup) };
}

async function getDuplicateScanSession() {
  const stored = await chrome.storage.local.get(DUPLICATE_SCAN_SESSION_KEY);
  const session = stored[DUPLICATE_SCAN_SESSION_KEY];
  if (!session?.scanId) return { ok: true, scanId: '', providers: [], groups: [] };
  return {
    ok: true,
    scanId: session.scanId,
    providers: session.providers || [],
    groups: (session.groups || []).map(duplicatePublicGroup)
  };
}

async function deleteMergedRecordAssets(record, settings) {
  const mediaRoot = `${normalizeVaultPath(settings.mediaPath || DEFAULT_MEDIA_PATH)}/`;
  for (const image of record.images || []) {
    const path = recordImagePath(record, image);
    if (!path.startsWith(mediaRoot)) continue;
    await deleteVaultFile(path, settings, true);
  }
}

async function reconcileMergedActivity(canonicalRef, duplicateRefs, sources) {
  const duplicateKeys = new Set(duplicateRefs.map(SP2OStorage.refKey));
  const canonicalKey = SP2OStorage.refKey(canonicalRef);
  const stored = await chrome.storage.local.get(['recentSaves', THREAD_CONTEXT_KEY]);
  const patchEntry = entry => SP2OStorage.refKey(entry.ref) === canonicalKey
    ? {
      ...entry,
      platforms: [...new Set(sources.map(source => source.platform))],
      sources,
      url: sources[0]?.url || entry.url
    }
    : entry;
  await chrome.storage.local.set({
    recentSaves: (stored.recentSaves || [])
      .filter(entry => !duplicateKeys.has(SP2OStorage.refKey(entry.ref)))
      .map(patchEntry),
    [THREAD_CONTEXT_KEY]: (stored[THREAD_CONTEXT_KEY] || [])
      .filter(entry => !duplicateKeys.has(SP2OStorage.refKey(entry.ref)))
      .map(patchEntry)
  });
}

async function mergeFileDuplicateGroup(group, settings) {
  const fresh = [];
  for (const snapshot of [group.canonical, ...group.duplicates]) {
    const markdown = await readVaultFile(snapshot.ref.path, settings);
    const record = await parseMarkdownPostRecord(markdown, snapshot.ref);
    if (!record || record.revision !== snapshot.revision || record.fingerprint !== group.fingerprint) {
      throw new Error(`「${snapshot.title}」在掃描後已變更`);
    }
    fresh.push({ ...record, markdown });
  }
  const canonical = fresh[0];
  const duplicates = fresh.slice(1);
  const sources = normalizeCrossPostSources(fresh.flatMap(record => record.sources));
  const mediaResults = await mergedMediaResults(null, canonical, duplicates, settings);
  const updated = mergeCrossPlatformMarkdown(
    canonical.markdown,
    group.fingerprint,
    sources,
    duplicates,
    mediaResults
  );
  await saveVaultFile(updated, canonical.ref.path, settings, 'text/markdown', vaultFileTime(canonical.createdAt));
  const verified = await parseMarkdownPostRecord(await readVaultFile(canonical.ref.path, settings), canonical.ref);
  if (!verified || verified.fingerprint !== group.fingerprint
    || !sources.every(source => verified.sources.some(item => item.externalKey === source.externalKey))) {
    throw new Error('canonical 筆記讀回驗證失敗，未刪除重複筆記');
  }
  for (const duplicate of duplicates) {
    await deleteVaultFile(duplicate.ref.path, settings, true);
    await deleteMergedRecordAssets(duplicate, settings);
  }
  await reconcileMergedActivity(canonical.ref, duplicates.map(record => record.ref), sources);
  await removeContentDedupeRefs(duplicates.map(record => record.ref));
  await recordContentDedupe(
    { platform: sources[0].platform, timestamp: canonical.createdAt, url: sources[0].url, content: 'indexed' },
    settings,
    canonical.ref,
    sources,
    group.fingerprint
  );
  return { ref: canonical.ref, sources };
}

async function mergeNotesDuplicateGroup(group, settings) {
  const fresh = [];
  for (const snapshot of [group.canonical, ...group.duplicates]) {
    const response = await sendNativeRequest({
      action: 'notesRead',
      accountId: settings.accountId,
      noteId: snapshot.ref.noteId,
      externalKey: snapshot.ref.externalKey
    });
    const record = await parseNotesPostRecord({
      noteId: snapshot.ref.noteId,
      title: snapshot.title,
      html: response.html,
      createdAt: snapshot.createdAt
    }, settings);
    if (!record || record.revision !== snapshot.revision || record.fingerprint !== group.fingerprint) {
      throw new Error(`「${snapshot.title}」在掃描後已變更`);
    }
    fresh.push(record);
  }
  const canonical = fresh[0];
  const duplicates = fresh.slice(1);
  const sources = normalizeCrossPostSources(fresh.flatMap(record => record.sources));
  const html = mergeCrossPlatformNotesHtml(canonical.html, group.fingerprint, sources, duplicates);
  await sendNativeRequest({
    action: 'notesMergeDuplicates',
    accountId: settings.accountId,
    folderId: settings.folderId,
    canonical: {
      noteId: canonical.ref.noteId,
      externalKey: canonical.ref.externalKey,
      revision: canonical.revision,
      title: canonical.title,
      html
    },
    duplicates: duplicates.map(record => ({
      noteId: record.ref.noteId,
      externalKey: record.ref.externalKey,
      revision: record.revision
    }))
  });
  await reconcileMergedActivity(canonical.ref, duplicates.map(record => record.ref), sources);
  await removeContentDedupeRefs(duplicates.map(record => record.ref));
  await recordContentDedupe(
    { platform: sources[0].platform, timestamp: canonical.createdAt, url: sources[0].url, content: 'indexed' },
    settings,
    canonical.ref,
    sources,
    group.fingerprint
  );
  return { ref: canonical.ref, sources };
}

async function mergeDuplicatePosts(scanId, groupIds) {
  const stored = await chrome.storage.local.get(DUPLICATE_SCAN_SESSION_KEY);
  const session = stored[DUPLICATE_SCAN_SESSION_KEY];
  if (!session || session.scanId !== scanId) throw new Error('掃描結果已失效，請重新掃描');
  const selected = new Set(Array.isArray(groupIds) ? groupIds : []);
  let merged = 0;
  let skipped = 0;
  const errors = [];
  for (const group of session.groups || []) {
    if (!selected.has(group.id) || group.blocked) continue;
    try {
      const settings = await settingsForProvider(group.provider);
      await getProvider(settings).mergeDuplicateGroup(group, settings);
      merged++;
    } catch (error) {
      skipped++;
      errors.push(`${group.canonical.title}：${error.message}`);
    }
  }
  await chrome.storage.local.remove(DUPLICATE_SCAN_SESSION_KEY);
  return { ok: true, merged, skipped, errors };
}

// 同一則貼文可能用過的所有檔名。舊版檔名沒有 _HHmm，只比對現行格式的話，
// 早期存的筆記會被判定成「沒存過」而重複建檔。
function candidateFilenames(data) {
  const current = generateFilename(data);
  const legacy = current.replace(/^(\d{4}-\d{2}-\d{2})_\d{4}_/, '$1_');
  return legacy === current ? [current] : [current, legacy];
}

function candidateVaultPaths(data, basePath) {
  const category = classifyPost(data);
  const directories = category ? [`${basePath}/${category.folder}`, basePath] : [basePath];
  return directories.flatMap(directory => (
    candidateFilenames(data).map(filename => `${directory}/${filename}`)
  ));
}

async function syncVaultActivity({ skipAppleNotes = false } = {}) {
  const stored = await chrome.storage.local.get([
    'draftStatus_x',
    'draftStatus_threads',
    'recentSaves'
  ]);
  const draftEntries = [
    ['draftStatus_x', stored.draftStatus_x],
    ['draftStatus_threads', stored.draftStatus_threads]
  ];
  const existence = new Map();

  async function exists(ref) {
    if (!ref) return true;
    if (skipAppleNotes && ref.provider === SP2OStorage.PROVIDERS.APPLE_NOTES) return true;
    const key = SP2OStorage.refKey(ref);
    if (!existence.has(key)) {
      const settings = await settingsForProvider(ref.provider);
      validateProviderSettings(settings);
      existence.set(key, getProvider(settings).exists(ref, settings));
    }
    return existence.get(key);
  }

  let removedDrafts = 0;
  for (const [key, draft] of draftEntries) {
    if (!draft || await exists(draft.ref)) continue;
    await chrome.storage.local.remove(key);
    await chrome.storage.local.remove(key.replace('draftStatus_', 'draftSnapshot_'));
    removedDrafts++;
  }

  const recentSaves = stored.recentSaves || [];
  const existingRecentSaves = [];
  const removedRecentRefs = [];
  for (const item of recentSaves) {
    if (await exists(item.ref)) existingRecentSaves.push(item);
    else removedRecentRefs.push(item.ref);
  }
  const removedRecent = recentSaves.length - existingRecentSaves.length;
  if (removedRecent > 0) {
    await chrome.storage.local.set({ recentSaves: existingRecentSaves });
    await removeThreadContexts(removedRecentRefs);
    const markdownSettings = await settingsForProvider(SP2OStorage.PROVIDERS.MARKDOWN_FOLDER);
    await cleanupEmptyMediaFolders(markdownSettings);
  }

  return { ok: true, removedDrafts, removedRecent };
}

async function deleteVaultActivity(message) {
  const stored = await chrome.storage.local.get([
    'draftStatus_x',
    'draftStatus_threads',
    'recentSaves'
  ]);
  let target;

  if (message.kind === 'draft') {
    const draftEntries = [
      ['draftStatus_x', stored.draftStatus_x],
      ['draftStatus_threads', stored.draftStatus_threads]
    ];
    const matched = draftEntries.find(([key, draft]) => (
      key === message.key
      || (message.ref && SP2OStorage.refKey(draft?.ref) === SP2OStorage.refKey(message.ref))
    ));
    if (matched) target = { key: matched[0], ref: matched[1].ref };
  } else if (message.kind === 'recent') {
    const recentSaves = stored.recentSaves || [];
    if (recentSaves.some(item => SP2OStorage.refKey(item.ref) === SP2OStorage.refKey(message.ref))) {
      target = { ref: message.ref, recentSaves };
    }
  }

  if (!target) throw new Error('找不到要刪除的貼文');
  if (target.ref) {
    const settings = await settingsForProvider(target.ref.provider);
    await getProvider(settings).delete(target.ref, settings, true);
    await removeContentDedupeRefs([target.ref]);
  }

  if (target.key) {
    await chrome.storage.local.remove(target.key.replace('draftStatus_', 'draftSnapshot_'));
    await chrome.storage.local.remove(target.key);
  } else {
    await chrome.storage.local.set({
      recentSaves: target.recentSaves.filter(item => SP2OStorage.refKey(item.ref) !== SP2OStorage.refKey(target.ref))
    });
    await removeThreadContexts([target.ref]);
    if (target.ref.provider === SP2OStorage.PROVIDERS.MARKDOWN_FOLDER) {
      await cleanupEmptyMediaFolders(await settingsForProvider(target.ref.provider));
    }
  }

  return { ok: true };
}

// 處理手機貼文補存與舊版 SAVE_POST；同樣先套用三日自回覆合併。
async function handleSavePost(data, tabId, silent = false) {
  try {
    const settings = await getStorageSettings();
    validateProviderSettings(settings);

    await withCrossPostLock(data, settings, async (fingerprint) => {
      const prepared = await prepareStoragePost(data, settings, fingerprint);
      await saveWithQueueFallback(
        prepared.fullPath,
        prepared.filename,
        prepared.data,
        settings,
        tabId,
        { ...prepared, silent }
      );
    });
    return { ok: true };
  } catch (error) {
    console.error('[Social Post to Obsidian] Save failed:', error);
    notifyResult(tabId, false, error.message, silent);
    return { ok: false, error: error.message };
  }
}

// ===== 離線佇列：寫入方式不可用時先排隊，恢復後自動補存 =====

const QUEUE_KEY = 'offlineQueue';
const RETRY_ALARM = 'sp2o-retry-queue';

function isConnectionError(error) {
  return error.isStorageUnavailableError
    || error.isObsidianConnectionError
    || (error instanceof TypeError && /Failed to fetch|NetworkError/i.test(error.message || ''));
}

async function enqueueOffline(item) {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue = stored[QUEUE_KEY] || [];
  queue.push({ ...item, queuedAt: new Date().toISOString() });
  // 上限 50 筆，避免無限成長
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-50) });
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  console.log('[Social Post to Obsidian] Queued for retry:', item.filename);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) {
    enqueue('offline-retry', retryOfflineQueue);
  } else if (alarm.name === X_BACKFILL_TIMEOUT_ALARM) {
    enqueue('x-backfill-timeout', async () => {
      const stored = await chrome.storage.local.get(X_BACKFILL_JOB_KEY);
      const job = stored[X_BACKFILL_JOB_KEY];
      if (!job) return;
      await clearXBackfillJob(job, false);
      console.log('[Social Post to Obsidian] X 背景補存掃描逾時，已關閉暫存分頁');
    });
  } else if (alarm.name === MAINTENANCE_ALARM) {
    enqueue('vault-maintenance', async () => {
      const settings = await getStorageSettings();
      if (settings.storageProvider === SP2OStorage.PROVIDERS.MARKDOWN_FOLDER) {
        await cleanupEmptyMediaFolders(settings);
      } else {
        chrome.alarms.clear(MAINTENANCE_ALARM);
      }
    });
  } else if (alarm.name === ARCHIVE_ALARM) {
    enqueue('vault-maintenance', async () => {
      const settings = await getStorageSettings();
      if (!getProvider(settings).capabilities.archive) {
        stopArchiveMaintenance();
        return;
      }
      try {
        await archiveOldSocialPosts(settings);
      } catch (error) {
        console.log('[Social Post to Obsidian] Obsidian 封存暫時無法執行:', error.message);
      }
    });
  }
});

async function retryOfflineQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const queue = stored[QUEUE_KEY] || [];
  if (queue.length === 0) {
    chrome.alarms.clear(RETRY_ALARM);
    return;
  }

  const remaining = [];
  let saved = 0;
  for (const item of queue) {
    try {
      const providerId = item.provider || item.ref?.provider;
      const settings = await settingsForProvider(providerId);
      validateProviderSettings(settings);
      const provider = getProvider(settings);
      const ref = item.ref;
      const context = {
        ...item,
        ref,
        fullPath: ref?.path,
        filename: item.filename || ref?.title
      };
      if ((item.appendExisting || item.crossPlatformExisting) && ref?.path) {
        context.existingMarkdown = await readVaultFile(ref.path, settings).catch(() => item.existingMarkdown);
      }
      const result = await provider.savePublished(item.data, context, settings);
      await recordRecentSave({
        filename: item.filename,
        ref: result.ref || ref,
        platform: item.platform,
        platforms: [...new Set((item.sources || item.data?.sources || [sourceForPost(item.data)])
          .map(source => source.platform))],
        sources: item.sources || item.data?.sources,
        url: item.appendExisting ? (item.mergeUrls?.[0] || item.data?.replyTo || item.url) : item.url,
        preview: item.data?.rawMarkdown
          ? createContentPreview(item.data.rawMarkdown)
          : createPostPreview(item.data),
        mergeSegments: item.data?.rawMarkdown ? undefined : (item.mergeSegments || [item.data]),
        mergeMode: item.appendExisting ? 'markdown' : '',
        rootTimestamp: item.rootTimestamp,
        mergeUrls: item.data?.rawMarkdown ? undefined : (item.mergeUrls || publishedPostUrls(item.data))
      });
      await recordContentDedupe(
        item.data,
        settings,
        result.ref || ref,
        item.sources || item.data?.sources,
        item.fingerprint || item.data?.contentFingerprint
      );
      if (providerId === SP2OStorage.PROVIDERS.APPLE_NOTES && item.data?.platform) {
        const snapshotKey = `draftSnapshot_${item.data.platform}`;
        const statusKey = `draftStatus_${item.data.platform}`;
        const draftState = await chrome.storage.local.get([snapshotKey, statusKey]);
        const sameSession = !item.data.draftSessionId
          || !draftState[snapshotKey]?.draftSessionId
          || draftState[snapshotKey].draftSessionId === item.data.draftSessionId;
        if (sameSession) await chrome.storage.local.remove([snapshotKey, statusKey]);
      }
      saved++;
    } catch (error) {
      remaining.push(item);
    }
  }

  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  if (saved > 0) {
    showNotification('已補存', `儲存目的地恢復可用，補存 ${saved} 則貼文`);
  }
  if (remaining.length === 0) {
    chrome.alarms.clear(RETRY_ALARM);
  }
}

// service worker 啟動：一次讀完設定與佇列（SW 常被 kill/重啟，減少每次冷啟動的 storage 往返）
ensureStorageSchema().then(async () => {
  const stored = await chrome.storage.local.get([...STORAGE_SETTING_KEYS, QUEUE_KEY]);
  // 佇列有東西就確保重試 alarm 存在
  if ((stored[QUEUE_KEY] || []).length > 0) {
    chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  }

  syncArchiveMaintenance(stored);
  if (stored.storageProvider !== SP2OStorage.PROVIDERS.MARKDOWN_FOLDER) return;
  const status = await sendNativeRequest({ action: 'ping' });
  if (!status.configured) return;
  await chrome.storage.local.set({
    markdownFolderSettings: {
      ...(stored.markdownFolderSettings || {}),
      folderName: status.folderName,
      isObsidianVault: status.isObsidianVault === true
    }
  });
  await startNativeMaintenance();
}).catch((error) => {
  console.log('[Social Post to Obsidian] Native Helper not ready:', error.message);
});

// 記錄最近儲存（popup 顯示用，保留 5 筆）
async function recordRecentSave(entry) {
  const {
    mergeSegments, mergeMode, rootTimestamp, mergeUrls, ...recentEntry
  } = entry;
  const keepsThreadContext = Array.isArray(mergeSegments) || mergeMode === 'markdown';
  const storageKeys = keepsThreadContext ? ['recentSaves', THREAD_CONTEXT_KEY] : ['recentSaves'];
  const stored = await chrome.storage.local.get(storageKeys);
  // 同一 StorageRef 代表同一份內容（補存／修正會覆寫），避免最近清單重複。
  const now = new Date();
  const recentKey = SP2OStorage.refKey(recentEntry.ref);
  const recentSaves = (stored.recentSaves || []).filter(item => SP2OStorage.refKey(item.ref) !== recentKey);
  recentSaves.unshift({ ...recentEntry, savedAt: now.toISOString() });
  const updates = { recentSaves: recentSaves.slice(0, 5) };

  // popup 最近儲存固定只顯示 5 筆，不能拿它當三日合併索引；另存短期 context，
  // 並按實際記錄時間清掉過期項目，避免長期保留完整貼文內容。
  if (keepsThreadContext) {
    const contexts = (stored[THREAD_CONTEXT_KEY] || []).filter((item) => {
      if (SP2OStorage.refKey(item.ref) === recentKey) return false;
      const recordedAt = new Date(item.recordedAt).getTime();
      return Number.isFinite(recordedAt)
        && now.getTime() - recordedAt <= RECENT_THREAD_APPEND_WINDOW_MS;
    });
    contexts.unshift({
      filename: recentEntry.filename,
      ref: recentEntry.ref,
      platform: recentEntry.platform,
      url: recentEntry.url,
      mergeSegments,
      mergeMode,
      rootTimestamp,
      mergeUrls,
      recordedAt: now.toISOString()
    });
    updates[THREAD_CONTEXT_KEY] = contexts.slice(0, THREAD_CONTEXT_LIMIT);
  }

  await chrome.storage.local.set(updates);
}

async function removeThreadContexts(refs) {
  const removedRefs = new Set((refs || []).filter(Boolean).map(SP2OStorage.refKey));
  if (!removedRefs.size) return;
  const stored = await chrome.storage.local.get(THREAD_CONTEXT_KEY);
  const contexts = stored[THREAD_CONTEXT_KEY] || [];
  const retained = contexts.filter(item => !removedRefs.has(SP2OStorage.refKey(item.ref)));
  if (retained.length !== contexts.length) {
    await chrome.storage.local.set({ [THREAD_CONTEXT_KEY]: retained });
  }
}

function createContentPreview(content, maxLength = 160) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  return characters.slice(0, maxLength).join('') + '…';
}

function createPostPreview(data) {
  const threadItems = getThreadItems(data);
  const text = createContentPreview(threadItems[0] || data?.content);
  if (text) return threadItems.length > 1 ? `${text} · 共 ${threadItems.length} 則` : text;
  const mediaCount = Array.isArray(data?.media) ? data.media.length : 0;
  return mediaCount > 0 ? `圖片貼文 · ${mediaCount} 張圖片` : '沒有文字內容';
}

function normalizedCrossPostText(data) {
  if (!data || data.replyTo || data.quoted) return '';
  const threadItems = getThreadItems(data);
  const value = threadItems.length ? threadItems.join(' ') : String(data.content || '');
  return value.replace(/\s+/gu, ' ').trim();
}

async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function contentFingerprint(data) {
  const normalized = normalizedCrossPostText(data);
  return normalized ? `sha256:${await sha256Hex(normalized)}` : '';
}

function sourceForPost(data) {
  const url = String(data?.url || '');
  return {
    platform: data?.platform === 'x' ? 'x' : 'threads',
    url,
    publishedAt: String(data?.timestamp || ''),
    externalKey: postIdentity(url) || url
  };
}

function normalizeCrossPostSources(sources) {
  const byIdentity = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!['x', 'threads'].includes(source?.platform)) continue;
    const url = String(source.url || '');
    const externalKey = String(source.externalKey || postIdentity(url) || url);
    if (!externalKey) continue;
    byIdentity.set(externalKey, {
      platform: source.platform,
      url,
      publishedAt: String(source.publishedAt || ''),
      externalKey
    });
  }
  return [...byIdentity.values()].sort((left, right) => {
    const time = Date.parse(left.publishedAt) - Date.parse(right.publishedAt);
    return Number.isFinite(time) && time !== 0 ? time : left.externalKey.localeCompare(right.externalKey);
  });
}

function sourcesForPost(data, additional = []) {
  return normalizeCrossPostSources([...additional, sourceForPost(data)]);
}

function dedupeScopeKey(settings) {
  const basePath = normalizeVaultPath(settings.basePath || DEFAULT_BASE_PATH);
  if (settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES) {
    return `${settings.storageProvider}:${settings.accountId || ''}:${settings.folderId || ''}`;
  }
  if (settings.storageProvider === SP2OStorage.PROVIDERS.OBSIDIAN_REST) {
    return `${settings.storageProvider}:${Number(settings.port) || 27123}:${basePath}`;
  }
  return `${settings.storageProvider}:${settings.folderName || ''}:${basePath}`;
}

async function recordContentDedupe(data, settings, ref, sources, fingerprint) {
  const resolvedFingerprint = fingerprint || await contentFingerprint(data);
  if (!resolvedFingerprint || !ref) return;
  const normalizedSources = normalizeCrossPostSources(sources?.length ? sources : [sourceForPost(data)]);
  await mutateContentDedupeIndex((index) => {
    const scope = dedupeScopeKey(settings);
    const scoped = { ...(index[scope] || {}) };
    const refKey = SP2OStorage.refKey(ref);
    const entries = (scoped[resolvedFingerprint] || []).filter(entry => SP2OStorage.refKey(entry.ref) !== refKey);
    entries.push({
      ref,
      title: ref.title || '',
      createdAt: normalizedSources[0]?.publishedAt || data.timestamp || '',
      platforms: [...new Set(normalizedSources.map(source => source.platform))],
      sources: normalizedSources
    });
    scoped[resolvedFingerprint] = entries;
    return { ...index, [scope]: scoped };
  });
}

async function mutateContentDedupeIndex(mutator) {
  const task = contentDedupeIndexMutation.then(async () => {
    const stored = await chrome.storage.local.get(CONTENT_DEDUPE_INDEX_KEY);
    const index = stored[CONTENT_DEDUPE_INDEX_KEY] || {};
    const next = await mutator(index);
    await chrome.storage.local.set({ [CONTENT_DEDUPE_INDEX_KEY]: next });
    return next;
  });
  contentDedupeIndexMutation = task.catch(() => {});
  return task;
}

async function removeContentDedupeRefs(refs) {
  const removed = new Set((refs || []).map(SP2OStorage.refKey));
  if (!removed.size) return;
  await mutateContentDedupeIndex((index) => {
    const next = {};
    for (const [scope, fingerprints] of Object.entries(index)) {
      const scoped = {};
      for (const [fingerprint, entries] of Object.entries(fingerprints || {})) {
        const retained = (entries || []).filter(entry => !removed.has(SP2OStorage.refKey(entry.ref)));
        if (retained.length) scoped[fingerprint] = retained;
      }
      next[scope] = scoped;
    }
    return next;
  });
}

function crossPostCandidateEntries(index, settings, fingerprint, platform) {
  const entries = index?.[dedupeScopeKey(settings)]?.[fingerprint] || [];
  return entries
    .filter(entry => !(entry.platforms || []).includes(platform))
    .sort((left, right) => {
      const time = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return Number.isFinite(time) && time !== 0
        ? time
        : SP2OStorage.refKey(left.ref).localeCompare(SP2OStorage.refKey(right.ref));
    });
}

async function withCrossPostLock(data, settings, task) {
  const fingerprint = await contentFingerprint(data);
  if (!fingerprint) return task('');
  const key = `cross-post:${dedupeScopeKey(settings)}:${fingerprint}`;
  const previous = taskChains[key] || Promise.resolve();
  const current = previous.then(() => task(fingerprint));
  taskChains[key] = current.catch(() => {});
  return current;
}

async function readVaultBinary(filepath, settings) {
  if (resolveStorageMode(settings) === 'native') {
    const response = await sendNativeRequest({ action: 'readBinary', path: filepath });
    const decoded = atob(String(response.data || ''));
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  }
  let response;
  try {
    response = await fetch(`${apiBase(settings.port || 27123)}/vault/${encodeURIComponent(filepath)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${settings.apiKey}` }
    });
  } catch (error) {
    error.isObsidianConnectionError = true;
    throw error;
  }
  if (!response.ok) throw new Error(`讀取 Vault 圖片失敗：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function recordImagePath(record, image) {
  if (/^(?:https?:|data:)/i.test(image.target)) return image.target;
  const noteDirectory = record.ref.path.includes('/')
    ? record.ref.path.slice(0, record.ref.path.lastIndexOf('/'))
    : '';
  return resolveArchiveLink(noteDirectory, image.target);
}

function nextImageNumber(records) {
  return Math.max(0, ...records.flatMap(record => (record.images || []).map((image) => {
    const match = /image-(\d+)\.[a-z0-9]+$/i.exec(image.target);
    return match ? Number(match[1]) : 0;
  })));
}

async function mergedMediaResults(data, canonical, duplicateRecords, settings) {
  const records = [canonical, ...(duplicateRecords || [])];
  const canonicalDirectory = canonical.ref.path.includes('/')
    ? canonical.ref.path.slice(0, canonical.ref.path.lastIndexOf('/'))
    : '';
  const assetFolder = noteBasename(canonical.ref.path).replace(/\.md$/i, '');
  const mediaDirectory = normalizeVaultPath(settings.mediaPath || DEFAULT_MEDIA_PATH);
  const seenHashes = new Set();
  const seenRemote = new Set((canonical.images || [])
    .map(image => image.target)
    .filter(target => /^(?:https?:|data:)/i.test(target)));
  const additions = [];
  let imageNumber = nextImageNumber(records);

  for (const record of records) {
    for (const image of record.images || []) {
      const sourcePath = recordImagePath(record, image);
      if (/^(?:https?:|data:)/i.test(sourcePath)) {
        if (record !== canonical && !seenRemote.has(sourcePath)) {
          seenRemote.add(sourcePath);
          additions.push({ url: sourcePath, alt: image.alt || `圖片 ${++imageNumber}` });
        }
        continue;
      }
      const bytes = await readVaultBinary(sourcePath, settings);
      const hash = await sha256Hex(bytes);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      if (record === canonical) continue;
      const extension = /\.([a-z0-9]+)$/i.exec(sourcePath)?.[1]?.toLowerCase() || 'bin';
      const imageName = `image-${String(++imageNumber).padStart(2, '0')}.${extension}`;
      const targetPath = `${mediaDirectory}/${assetFolder}/${imageName}`;
      await saveVaultFile(bytes, targetPath, settings, `image/${extension === 'jpg' ? 'jpeg' : extension}`);
      additions.push({
        path: relativeVaultPath(canonicalDirectory, targetPath),
        alt: image.alt || `圖片 ${imageNumber}`
      });
    }
  }

  for (const item of Array.isArray(data?.media) ? data.media.slice(0, 20) : []) {
    try {
      const image = await downloadImage(item.url);
      const bytes = new Uint8Array(image.bytes);
      const hash = await sha256Hex(bytes);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const imageName = `image-${String(++imageNumber).padStart(2, '0')}.${image.extension}`;
      const targetPath = `${mediaDirectory}/${assetFolder}/${imageName}`;
      await saveVaultFile(bytes, targetPath, settings, image.contentType);
      additions.push({
        path: relativeVaultPath(canonicalDirectory, targetPath),
        alt: item.alt || `圖片 ${imageNumber}`
      });
    } catch (error) {
      if (error.isObsidianApiError || error.isVaultWriteError) throw error;
      if (!seenRemote.has(item.url)) {
        seenRemote.add(item.url);
        additions.push({ url: item.url, alt: item.alt || `圖片 ${imageNumber + 1}`, failed: true });
      }
    }
  }
  return additions;
}

// 回報存檔結果：優先在原分頁顯示 toast，分頁不在了才用系統通知
// backfill：自動補存的結果。分頁端據此不清掉草稿狀態列，補存也不跳系統通知
// （使用者可能根本不在該分頁前，背景補存不該打斷）。
function notifyResult(tabId, ok, text, backfill = false) {
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SAVE_RESULT', ok, text, backfill }, () => {
      if (chrome.runtime.lastError && !backfill) {
        showNotification(ok ? '存檔成功' : '存檔失敗', text);
      }
    });
  } else if (!backfill) {
    showNotification(ok ? '存檔成功' : '存檔失敗', text);
  }
}

function getThreadItems(data) {
  if (!Array.isArray(data?.thread)) return [];
  return data.thread
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

const X_POST_CATEGORIES = {
  post: { type: 'post', label: '發文', folder: '發文' },
  reply: { type: 'reply', label: '回覆', folder: '回覆' },
  quote: { type: 'quote', label: '引用', folder: '引用' },
  thread: { type: 'thread', label: '串文', folder: '串文' }
};

function xAuthorFromStatusUrl(url) {
  const match = String(url || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/\d+/i);
  return match ? match[1].toLowerCase() : '';
}

// X 正式筆記的主分類。多則內容與回覆自己都視為串文；引用優先於一般回覆。
function classifyPost(data) {
  if (data?.platform !== 'x') return null;
  const ownAuthor = xAuthorFromStatusUrl(data.url);
  const replyAuthor = xAuthorFromStatusUrl(data.replyTo);
  if (getThreadItems(data).length > 1 || (ownAuthor && ownAuthor === replyAuthor)) {
    return X_POST_CATEGORIES.thread;
  }
  if (data.quoted) return X_POST_CATEGORIES.quote;
  if (data.replyTo) return X_POST_CATEGORIES.reply;
  return X_POST_CATEGORIES.post;
}

function publishedPostLocation(data, basePath) {
  const filename = generateFilename(data);
  const category = classifyPost(data);
  // 最近 7 天留在根目錄方便瀏覽；定期維護再按 category 歸檔。
  return { filename, fullPath: `${basePath}/${filename}`, category };
}

function publishedPostUrls(data) {
  const urls = [data?.url, ...(Array.isArray(data?.threadUrls) ? data.threadUrls : [])]
    .map(url => String(url || ''))
    .filter(Boolean);
  return [...new Set(urls)];
}

function mergeSegmentKey(data) {
  if (data?.draftSessionId) return `session:${data.draftSessionId}`;
  const identity = postIdentity(data?.url);
  return identity ? `post:${identity}` : '';
}

function upsertMergeSegment(segments, data) {
  const next = (Array.isArray(segments) ? segments : []).slice();
  const key = mergeSegmentKey(data);
  const index = key ? next.findIndex(segment => mergeSegmentKey(segment) === key) : -1;
  if (index >= 0) next[index] = data;
  else next.push(data);
  return next;
}

function mergePublishedSegments(segments) {
  const root = segments[0];
  const items = segments.flatMap((segment) => {
    const threadItems = getThreadItems(segment);
    if (threadItems.length) return threadItems;
    const content = String(segment?.content || '').trim();
    return content ? [content] : [];
  });
  const media = segments.flatMap(segment => Array.isArray(segment?.media) ? segment.media : []);
  const threadUrls = [...new Set(segments.flatMap(publishedPostUrls))];
  return {
    ...root,
    content: items.join('\n\n---\n\n'),
    ...(items.length > 1 ? { thread: items } : {}),
    ...(media.length ? { media } : {}),
    threadUrls
  };
}

function xStatusTimestamp(url) {
  const match = String(url || '').match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  if (!match) return NaN;
  try {
    return Number((BigInt(match[1]) >> 22n) + 1288834974657n);
  } catch (error) {
    return NaN;
  }
}

function markdownCreatedTimestamp(markdown) {
  const match = /^created:\s*["']?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/m.exec(String(markdown || ''));
  return match ? new Date(`${match[1]}T${match[2]}:00`).getTime() : NaN;
}

async function findExistingThreadRoot(data, basePath, settings, replyIdentity, recentSaves) {
  let candidate = (recentSaves || []).find((entry) => (
    entry.platform === data.platform
    && entry.ref?.provider === settings.storageProvider
    && entry.ref?.path
    && postIdentity(entry.url) === replyIdentity
  ));

  if (!candidate) {
    const index = await vaultNoteIndex(basePath, settings);
    const entry = index?.entries?.find(item => postIdentity(item.sourceUrl) === replyIdentity);
    if (entry?.name) {
      candidate = {
        filename: noteBasename(entry.name),
        ref: SP2OStorage.fileRef(
          settings.storageProvider,
          `${basePath}/${entry.name}`,
          noteBasename(entry.name),
          entry.sourceUrl
        ),
        platform: data.platform,
        url: entry.sourceUrl
      };
    }
  }
  if (!candidate) return null;

  const existingMarkdown = await readVaultFile(candidate.ref.path, settings);
  const rootTimestamp = xStatusTimestamp(candidate.url || data.replyTo)
    || markdownCreatedTimestamp(existingMarkdown);
  const publishedAt = new Date(data.timestamp).getTime();
  const gap = publishedAt - rootTimestamp;
  if (!Number.isFinite(gap) || gap < 0 || gap > RECENT_THREAD_APPEND_WINDOW_MS) return null;

  return {
    ...candidate,
    existingMarkdown,
    rootTimestamp: new Date(rootTimestamp).toISOString(),
    mergeMode: 'markdown',
    mergeUrls: [candidate.url || data.replyTo]
  };
}

async function preparePublishedPost(data, basePath, settings) {
  const location = publishedPostLocation(data, basePath);
  const replyIdentity = postIdentity(data?.replyTo);
  if (!replyIdentity) return { ...location, data, merged: false, mergeSegments: [data] };

  const stored = await chrome.storage.local.get([THREAD_CONTEXT_KEY, 'recentSaves']);
  const publishedAt = new Date(data.timestamp).getTime();
  // 相容短暫載入過 v2.12.0 初版的狀態：當獨立 context 尚未建立時，
  // 仍可從當時寫入 recentSaves 的 mergeSegments 接回原筆記。
  const legacyContexts = (stored.recentSaves || []).filter(entry => Array.isArray(entry.mergeSegments));
  const contexts = [...(stored[THREAD_CONTEXT_KEY] || []), ...legacyContexts];
  const target = contexts.find((entry) => {
    if (entry.platform !== data.platform || entry.ref?.provider !== settings.storageProvider || !entry.ref?.path
      || (!Array.isArray(entry.mergeSegments) && entry.mergeMode !== 'markdown')) {
      return false;
    }
    const matchesReply = (entry.mergeUrls || [entry.url]).some(
      url => postIdentity(url) === replyIdentity
    );
    if (!matchesReply) return false;

    const rootAt = new Date(entry.rootTimestamp || entry.mergeSegments?.[0]?.timestamp).getTime();
    const gap = publishedAt - rootAt;
    return Number.isFinite(gap) && gap >= 0 && gap <= RECENT_THREAD_APPEND_WINDOW_MS;
  });
  const resolvedTarget = target || await findExistingThreadRoot(
    data, basePath, settings, replyIdentity, stored.recentSaves
  );
  if (!resolvedTarget) return { ...location, data, merged: false, mergeSegments: [data] };

  if (resolvedTarget.mergeMode === 'markdown') {
    const existingMarkdown = resolvedTarget.existingMarkdown
      || await readVaultFile(resolvedTarget.ref.path, settings);
    return {
      filename: resolvedTarget.filename || noteBasename(resolvedTarget.ref.path),
      fullPath: resolvedTarget.ref.path,
      category: X_POST_CATEGORIES.thread,
      data,
      merged: true,
      appendExisting: true,
      // 合併失敗改另存新檔時，用來在新筆記標註母筆記
      threadRoot: resolvedTarget.filename || noteBasename(resolvedTarget.ref.path),
      existingMarkdown,
      rootTimestamp: resolvedTarget.rootTimestamp,
      mergeSegments: upsertMergeSegment(resolvedTarget.mergeSegments, data),
      mergeUrls: [...new Set([...(resolvedTarget.mergeUrls || [resolvedTarget.url]), ...publishedPostUrls(data)])]
    };
  }

  const mergeSegments = upsertMergeSegment(resolvedTarget.mergeSegments, data);
  const mergedData = mergePublishedSegments(mergeSegments);
  return {
    filename: resolvedTarget.filename || noteBasename(resolvedTarget.ref.path),
    fullPath: resolvedTarget.ref.path,
    category: classifyPost(mergedData),
    data: mergedData,
    merged: true,
    mergeSegments
  };
}

async function prepareNotesPost(data, settings) {
  const title = extractTitle(getThreadItems(data)[0] || data.content) || `${platformDisplayName(data.platform)} 貼文`;
  const basic = {
    filename: title,
    data,
    merged: false,
    mergeSegments: [data],
    mergeUrls: publishedPostUrls(data)
  };
  const replyIdentity = postIdentity(data.replyTo);
  if (!replyIdentity) {
    let existing;
    try {
      existing = await getProvider(settings).findBySource(data, settings);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
    }
    return existing ? { ...basic, ref: existing, replaceExisting: true } : basic;
  }

  const stored = await chrome.storage.local.get([THREAD_CONTEXT_KEY, 'recentSaves']);
  const publishedAt = new Date(data.timestamp).getTime();
  const target = (stored[THREAD_CONTEXT_KEY] || []).find((entry) => {
    if (entry.platform !== data.platform || entry.ref?.provider !== SP2OStorage.PROVIDERS.APPLE_NOTES) return false;
    if (!(entry.mergeUrls || [entry.url]).some(url => postIdentity(url) === replyIdentity)) return false;
    const rootAt = new Date(entry.rootTimestamp).getTime();
    const gap = publishedAt - rootAt;
    return Number.isFinite(gap) && gap >= 0 && gap <= RECENT_THREAD_APPEND_WINDOW_MS;
  });

  let ref = target?.ref;
  if (!ref) {
    const recent = (stored.recentSaves || []).find(entry => (
      entry.platform === data.platform
      && entry.ref?.provider === SP2OStorage.PROVIDERS.APPLE_NOTES
      && postIdentity(entry.url) === replyIdentity
    ));
    ref = recent?.ref;
  }
  if (!ref) {
    const response = await sendNativeRequest({
      action: 'notesFind',
      accountId: settings.accountId,
      folderId: settings.folderId,
      externalKey: replyIdentity
    });
    if (response.noteId) ref = SP2OStorage.notesRef(response.noteId, response.title, response.externalKey);
  }
  if (!ref) return basic;

  const inferredRootAt = xStatusTimestamp(data.replyTo);
  const rootTimestamp = target?.rootTimestamp
    || (Number.isFinite(inferredRootAt) ? new Date(inferredRootAt).toISOString() : '');
  const rootAt = new Date(rootTimestamp).getTime();
  if (!Number.isFinite(rootAt) || publishedAt - rootAt < 0
    || publishedAt - rootAt > RECENT_THREAD_APPEND_WINDOW_MS) return basic;
  return {
    ...basic,
    filename: ref.title || title,
    ref,
    merged: true,
    rootTimestamp,
    mergeSegments: upsertMergeSegment(target?.mergeSegments, data),
    mergeUrls: [...new Set([...(target?.mergeUrls || [data.replyTo]), ...publishedPostUrls(data)])]
  };
}

async function readIndexedPost(entry, settings) {
  if (!entry?.ref) return null;
  if (entry.ref.provider === SP2OStorage.PROVIDERS.APPLE_NOTES) {
    const response = await sendNativeRequest({
      action: 'notesRead',
      accountId: settings.accountId,
      noteId: entry.ref.noteId,
      externalKey: entry.ref.externalKey
    });
    return parseNotesPostRecord({
      noteId: entry.ref.noteId,
      title: entry.title || entry.ref.title,
      html: response.html,
      createdAt: entry.createdAt
    }, settings);
  }
  const markdown = await readVaultFile(entry.ref.path, settings);
  return parseMarkdownPostRecord(markdown, entry.ref);
}

async function prepareCrossPlatformPost(data, settings, fingerprint) {
  if (!fingerprint) return null;
  const stored = await chrome.storage.local.get(CONTENT_DEDUPE_INDEX_KEY);
  const candidates = crossPostCandidateEntries(
    stored[CONTENT_DEDUPE_INDEX_KEY] || {}, settings, fingerprint, data.platform
  );
  const staleRefs = [];
  for (const candidate of candidates) {
    try {
      const record = await readIndexedPost(candidate, settings);
      if (!record || record.fingerprint !== fingerprint || record.platforms.includes(data.platform)) {
        staleRefs.push(candidate.ref);
        continue;
      }
      record.sources = normalizeCrossPostSources([...(record.sources || []), ...(candidate.sources || [])]);
      record.platforms = [...new Set(record.sources.map(source => source.platform))];
      record.createdAt = record.createdAt || candidate.createdAt || '';
      const sources = sourcesForPost(data, record.sources);
      const enrichedData = { ...data, contentFingerprint: fingerprint, sources };
      if (settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES) {
        return {
          filename: record.title,
          data: enrichedData,
          merged: true,
          crossPlatformExisting: true,
          ref: record.ref,
          canonicalRecord: record,
          fingerprint,
          sources
        };
      }
      return {
        filename: record.ref.title || noteBasename(record.ref.path),
        fullPath: record.ref.path,
        data: enrichedData,
        merged: true,
        crossPlatformExisting: true,
        ref: record.ref,
        existingMarkdown: await readVaultFile(record.ref.path, settings),
        canonicalRecord: record,
        fingerprint,
        sources
      };
    } catch (error) {
      if (isConnectionError(error)) throw error;
      staleRefs.push(candidate.ref);
      console.log('[Social Post to Obsidian] 去重索引項目已失效:', error.message);
    }
  }
  if (staleRefs.length) await removeContentDedupeRefs(staleRefs);
  return null;
}

async function uniquePublishedLocation(prepared, data, settings) {
  if (!prepared.fullPath || prepared.merged || settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES) {
    return prepared;
  }
  const identity = postIdentity(data.url);
  let fullPath = prepared.fullPath;
  let filename = prepared.filename;
  let suffix = 2;
  while (await vaultFileExists(fullPath, settings)) {
    try {
      const existing = await parseMarkdownPostRecord(
        await readVaultFile(fullPath, settings),
        SP2OStorage.fileRef(settings.storageProvider, fullPath, filename, data.url)
      );
      if (identity && existing?.sources.some(source => source.externalKey === identity)) return prepared;
    } catch (error) {
      if (isConnectionError(error)) throw error;
    }
    filename = prepared.filename.replace(/\.md$/i, `_${suffix++}.md`);
    fullPath = `${settings.basePath || DEFAULT_BASE_PATH}/${filename}`;
  }
  return { ...prepared, fullPath, filename };
}

async function prepareStoragePost(data, settings, fingerprint = '') {
  const crossPlatform = await prepareCrossPlatformPost(data, settings, fingerprint);
  if (crossPlatform) return crossPlatform;
  const prepared = settings.storageProvider === SP2OStorage.PROVIDERS.APPLE_NOTES
    ? await prepareNotesPost(data, settings)
    : await preparePublishedPost(data, settings.basePath || DEFAULT_BASE_PATH, settings);
  const sources = fingerprint ? sourcesForPost(data) : [];
  const enriched = fingerprint
    ? {
      ...prepared,
      data: { ...prepared.data, contentFingerprint: fingerprint, sources },
      fingerprint,
      sources
    }
    : prepared;
  return uniquePublishedLocation(enriched, data, settings);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHtmlUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function notesParagraphs(value) {
  return String(value || '')
    .split(/\n{2,}/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function notesPostSectionHtml(data, heading = '') {
  const thread = getThreadItems(data);
  const content = thread.length ? thread : [String(data.content || '')];
  const headingHtml = heading ? `<h2>${escapeHtml(heading)}</h2>` : '';
  const contentHtml = content.map((item, index) => {
    const itemHeading = content.length > 1 ? `<h3>${index + 1} / ${content.length}</h3>` : '';
    return `${itemHeading}${notesParagraphs(item)}`;
  }).join('');
  const replyUrl = safeHtmlUrl(data.replyTo);
  const replyHtml = data.replyTo
    ? `<p><strong>回覆：</strong>${replyUrl
      ? `<a href="${escapeHtml(replyUrl)}">${escapeHtml(data.replyTo)}</a>`
      : escapeHtml(data.replyTo)}</p>`
    : '';
  const quoteHtml = data.quoted
    ? `<blockquote>${notesParagraphs(data.quoted.text || data.quoted.content || '')}</blockquote>`
    : '';
  const mediaHtml = (Array.isArray(data.media) ? data.media.slice(0, 20) : []).map((item, index) => {
    const mediaUrl = safeHtmlUrl(item.url);
    return `<p>${escapeHtml(item.alt || `圖片 ${index + 1}`)}${mediaUrl
      ? ` · <a href="${escapeHtml(mediaUrl)}">遠端來源</a>`
      : ''}</p>`;
  }).join('');
  return `${headingHtml}${contentHtml}${replyHtml}${quoteHtml}${mediaHtml}`;
}

function decodeNotesText(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function notesSources(html) {
  const sourceAt = String(html || '').search(/來源[：:]/);
  const region = sourceAt >= 0 ? String(html).slice(sourceAt, sourceAt + 4096) : String(html || '');
  const listSources = [...region.matchAll(/<li>([\s\S]*?)<\/li>/gi)].flatMap((match) => {
    const url = /https?:\/\/[^\s"'<>]+/i.exec(match[1])?.[0]?.replace(/&amp;/g, '&');
    if (!url || !postIdentity(url)) return [];
    const publishedAt = /（(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})）/.exec(decodeNotesText(match[1]))?.[1] || '';
    return [{
      platform: /(?:x|twitter)\.com\//i.test(url) ? 'x' : 'threads',
      url,
      publishedAt,
      externalKey: postIdentity(url)
    }];
  });
  if (listSources.length) return normalizeCrossPostSources(listSources);
  const urls = [...region.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(match => match[0].replace(/&amp;/g, '&'));
  const originalTime = /原始時間[：:]<\/strong>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/i.exec(String(html || ''))?.[1] || '';
  return normalizeCrossPostSources(urls.map((url) => ({
    platform: /(?:x|twitter)\.com\//i.test(url) ? 'x' : 'threads',
    url,
    publishedAt: originalTime,
    externalKey: postIdentity(url) || url
  })).filter(source => postIdentity(source.url)));
}

function notesFingerprint(html) {
  return /內容指紋[：:]<\/strong>\s*(sha256:[a-f0-9]{64})/i.exec(String(html || ''))?.[1] || '';
}

function notesPostText(html) {
  const paragraphs = [...String(html || '').matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
    .map(match => decodeNotesText(match[1]).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .filter(text => !/^(?:平台|原始時間|內容指紋|母筆記)[：:]/.test(text))
    .filter(text => !/^圖片\s*\d+(?:\s*·\s*遠端來源)?$/.test(text));
  return paragraphs.join(' ').replace(/\s+/gu, ' ').trim();
}

async function parseNotesPostRecord(entry, settings) {
  const html = String(entry.html || '');
  const sources = notesSources(html);
  if (!sources.length || /<strong>回覆[：:]<\/strong>|<blockquote/i.test(html)) return null;
  const storedFingerprint = notesFingerprint(html);
  const text = notesPostText(html);
  const fingerprint = storedFingerprint || (text ? `sha256:${await sha256Hex(text)}` : '');
  if (!fingerprint) return null;
  const externalKey = sources[0].externalKey;
  return {
    ref: SP2OStorage.notesRef(entry.noteId, entry.title, externalKey),
    title: entry.title || '未命名貼文',
    createdAt: entry.createdAt || sources[0].publishedAt || '',
    fingerprint,
    platforms: [...new Set(sources.map(source => source.platform))],
    sources,
    revision: `sha256:${await sha256Hex(html)}`,
    manualSections: [],
    images: [],
    html,
    modifiedAt: entry.modifiedAt || ''
  };
}

function renderNotesSources(sources) {
  const normalized = normalizeCrossPostSources(sources);
  return `<div><strong>來源：</strong><ul>${normalized.map((source) => {
    const url = safeHtmlUrl(source.url);
    return `<li>${escapeHtml(platformDisplayName(source.platform))}：${url
      ? `<a href="${escapeHtml(url)}">${escapeHtml(source.url)}</a>`
      : escapeHtml(source.url)}${source.publishedAt ? `（${escapeHtml(formatDateTime(source.publishedAt))}）` : ''}</li>`;
  }).join('')}</ul></div>`;
}

function mergeCrossPlatformNotesHtml(html, fingerprint, sources, duplicateRecords = []) {
  const normalized = normalizeCrossPostSources(sources);
  let result = String(html || '');
  const platform = `<p><strong>平台：</strong>${escapeHtml([...new Set(normalized.map(source => platformDisplayName(source.platform)))].join('、'))}</p>`;
  if (/<p><strong>平台[：:]<\/strong>[\s\S]*?<\/p>/i.test(result)) {
    result = result.replace(/<p><strong>平台[：:]<\/strong>[\s\S]*?<\/p>/i, platform);
  } else {
    result = result.replace(/<\/h1>/i, `</h1>${platform}`);
  }
  const fingerprintHtml = `<p><strong>內容指紋：</strong>${escapeHtml(fingerprint)}</p>`;
  if (/<p><strong>內容指紋[：:]<\/strong>[\s\S]*?<\/p>/i.test(result)) {
    result = result.replace(/<p><strong>內容指紋[：:]<\/strong>[\s\S]*?<\/p>/i, fingerprintHtml);
  } else if (/<p><strong>原始時間[：:]<\/strong>[\s\S]*?<\/p>/i.test(result)) {
    result = result.replace(/(<p><strong>原始時間[：:]<\/strong>[\s\S]*?<\/p>)/i, `$1${fingerprintHtml}`);
  }
  const sourceBlock = /<(?:div|p)><strong>來源[：:]<\/strong>[\s\S]*?<\/(?:div|p)>/i;
  if (!sourceBlock.test(result)) throw new Error('既有 Apple 備忘錄缺少來源區塊，無法安全合併');
  result = result.replace(sourceBlock, renderNotesSources(normalized));
  const manual = duplicateRecords.flatMap(record => record.manualSections || []);
  if (manual.length) {
    result += `<hr><h2>合併保留內容</h2>${manual.map(section => `<h3>保留內容</h3>${section}`).join('')}`;
  }
  return result;
}

function renderNotesHtml(data, title, externalKey, parentTitle = '') {
  const sources = normalizeCrossPostSources(data.sources?.length ? data.sources : [sourceForPost(data)]);
  const source = sources.length
    ? `<div><strong>來源：</strong><ul>${sources.map((item) => {
      const sourceUrl = safeHtmlUrl(item.url);
      return `<li>${escapeHtml(platformDisplayName(item.platform))}：${sourceUrl
        ? `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(item.url)}</a>`
        : escapeHtml(item.url)}${item.publishedAt ? `（${escapeHtml(formatDateTime(item.publishedAt))}）` : ''}</li>`;
    }).join('')}</ul></div>`
    : '';
  const parent = parentTitle ? `<p><strong>母筆記：</strong>${escapeHtml(parentTitle)}</p>` : '';
  const platforms = [...new Set(sources.map(item => platformDisplayName(item.platform)))];
  const fingerprint = data.contentFingerprint
    ? `<p><strong>內容指紋：</strong>${escapeHtml(data.contentFingerprint)}</p>`
    : '';
  return [
    `<div data-sp2o-key="${escapeHtml(externalKey)}">`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<p><strong>平台：</strong>${escapeHtml(platforms.join('、') || platformDisplayName(data.platform))}</p>`,
    `<p><strong>原始時間：</strong>${escapeHtml(formatDateTime(data.timestamp))}</p>`,
    fingerprint,
    source,
    parent,
    notesPostSectionHtml(data),
    '</div>'
  ].join('');
}

async function notesAttachments(data) {
  const media = Array.isArray(data.media) ? data.media.slice(0, 20) : [];
  const attachments = [];
  let failedMedia = 0;
  await Promise.all(media.map(async (item, index) => {
    try {
      const image = await downloadImage(item.url);
      attachments[index] = {
        name: `image-${String(index + 1).padStart(2, '0')}.${image.extension}`,
        contentType: image.contentType,
        data: arrayBufferToBase64(image.bytes)
      };
    } catch (error) {
      failedMedia++;
      console.log('[Social Post to Obsidian] Notes attachment skipped:', index + 1, error.message);
    }
  }));
  return { attachments: attachments.filter(Boolean), failedMedia };
}

async function saveNotesPublished(data, context, settings) {
  const title = context.filename || extractTitle(data.content) || `${platformDisplayName(data.platform)} 貼文`;
  const rootExternalKey = context.ref?.externalKey
    || postIdentity(context.mergeUrls?.[0] || data.url)
    || context.mergeUrls?.[0]
    || data.url;
  let noteId = context.ref?.noteId || '';
  if (!noteId && rootExternalKey) {
    const existing = await sendNativeRequest({
      action: 'notesFind',
      accountId: settings.accountId,
      folderId: settings.folderId,
      externalKey: rootExternalKey
    });
    if (existing.noteId) {
      noteId = existing.noteId;
      context = {
        ...context,
        replaceExisting: true,
        ref: SP2OStorage.notesRef(existing.noteId, existing.title || title, rootExternalKey)
      };
    }
  }
  let html;
  let merged = !!context.merged;
  let parentTitle = '';

  if (context.crossPlatformExisting && context.ref?.noteId) {
    const current = await sendNativeRequest({
      action: 'notesRead',
      accountId: settings.accountId,
      noteId: context.ref.noteId,
      externalKey: context.ref.externalKey
    });
    const record = await parseNotesPostRecord({
      noteId: context.ref.noteId,
      title: context.ref.title || title,
      html: current.html,
      createdAt: context.canonicalRecord?.createdAt
    }, settings);
    if (!record || record.fingerprint !== context.fingerprint) {
      throw new Error('既有 Apple 備忘錄內容已變更，跨平台合併已取消');
    }
    const existingHashes = await sendNativeRequest({
      action: 'notesAttachmentHashes',
      accountId: settings.accountId,
      noteId: context.ref.noteId,
      externalKey: context.ref.externalKey
    });
    const hashes = new Set(existingHashes.hashes || []);
    const media = await notesAttachments(data);
    const uniqueAttachments = [];
    for (const attachment of media.attachments) {
      const decoded = atob(attachment.data);
      const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
      const hash = await sha256Hex(bytes);
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      uniqueAttachments.push({ ...attachment, name: `image-${String(hashes.size).padStart(2, '0')}.${attachment.name.split('.').pop()}` });
    }
    const html = mergeCrossPlatformNotesHtml(current.html, context.fingerprint, context.sources);
    const response = await sendNativeRequest({
      action: 'notesUpsert',
      accountId: settings.accountId,
      folderId: settings.folderId,
      noteId: context.ref.noteId,
      title: context.ref.title || title,
      externalKey: context.ref.externalKey,
      html,
      attachments: uniqueAttachments
    });
    const verified = await sendNativeRequest({
      action: 'notesRead',
      accountId: settings.accountId,
      noteId: response.noteId,
      externalKey: context.ref.externalKey
    });
    if (notesFingerprint(verified.html) !== context.fingerprint
      || !context.sources.every(source => verified.html.includes(source.externalKey.split(':').pop())
        || verified.html.includes(source.url))) {
      throw new Error('Apple 備忘錄跨平台合併讀回驗證失敗');
    }
    return {
      ref: SP2OStorage.notesRef(response.noteId, response.title || title, context.ref.externalKey),
      savedMedia: uniqueAttachments.length,
      failedMedia: media.failedMedia,
      merged: true
    };
  }

  if (noteId) {
    try {
      const current = await sendNativeRequest({
        action: 'notesRead',
        accountId: settings.accountId,
        noteId,
        externalKey: rootExternalKey
      });
      if (current.externalKey !== rootExternalKey) {
        const mismatch = new Error('Apple 備忘錄身分不符');
        mismatch.notesSeparate = true;
        throw mismatch;
      }
      html = context.replaceExisting
        ? renderNotesHtml(data, title, rootExternalKey)
        : `${current.html}<hr>${notesPostSectionHtml(data, `追加於 ${formatDateTime(data.timestamp)}`)}`;
    } catch (error) {
      const code = error.nativeResponse?.code;
      if (!error.notesSeparate && !['NOTES_NOT_FOUND', 'NOTES_LOCKED', 'NOTES_IDENTITY_MISMATCH'].includes(code)) throw error;
      parentTitle = context.ref?.title || title;
      noteId = '';
      merged = false;
    }
  }

  const externalKey = noteId ? rootExternalKey : (postIdentity(data.url) || data.url);
  if (!html || !noteId) html = renderNotesHtml(data, title, externalKey, parentTitle);
  const media = await notesAttachments(data);
  const response = await sendNativeRequest({
    action: 'notesUpsert',
    accountId: settings.accountId,
    folderId: settings.folderId,
    noteId,
    title,
    externalKey,
    html,
    attachments: media.attachments
  });
  return {
    ref: SP2OStorage.notesRef(response.noteId, response.title || title, externalKey),
    savedMedia: Number(response.savedMedia ?? media.attachments.length),
    failedMedia: media.failedMedia + Number(response.failedMedia || 0),
    merged
  };
}

function renderCopyableContent(content) {
  const text = String(content || '');
  const fenceLength = (text.match(/`+/g) || [])
    .reduce((length, run) => Math.max(length, run.length + 1), 3);
  const fence = '`'.repeat(fenceLength);
  return `${fence}\n${text}\n${fence}`;
}

function renderContentSection(data, singleHeading, threadHeading) {
  const threadItems = getThreadItems(data);
  if (threadItems.length > 1) {
    const posts = threadItems.map((item, index) => (
      `### ${index + 1} / ${threadItems.length}\n\n${renderCopyableContent(item)}`
    ));
    return `## ${threadHeading}\n\n${posts.join('\n\n---\n\n')}`;
  }
  return `## ${singleHeading}\n\n${renderCopyableContent(data.content)}`;
}

function markdownFrontmatter(markdown) {
  return /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(markdown || ''));
}

function markdownScalar(frontmatter, key) {
  const line = String(frontmatter || '').split(/\r?\n/).find(item => item.startsWith(`${key}:`));
  if (!line) return '';
  const value = line.slice(key.length + 1).trim();
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^['"]|['"]$/g, '');
  }
}

function markdownSources(frontmatter) {
  const lines = String(frontmatter || '').split(/\r?\n/);
  const start = lines.findIndex(line => line === 'sources:');
  const sources = [];
  if (start >= 0) {
    let current;
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index];
      if (!/^\s+/.test(line)) break;
      const first = /^\s+-\s+platform:\s*(.+)$/.exec(line);
      const field = /^\s+(url|published_at|external_key):\s*(.+)$/.exec(line);
      if (first) {
        if (current) sources.push(current);
        current = { platform: markdownScalar(`platform: ${first[1]}`, 'platform') };
      } else if (field && current) {
        const key = field[1] === 'published_at' ? 'publishedAt'
          : field[1] === 'external_key' ? 'externalKey' : 'url';
        current[key] = markdownScalar(`${field[1]}: ${field[2]}`, field[1]);
      }
    }
    if (current) sources.push(current);
  }
  if (sources.length) return normalizeCrossPostSources(sources);
  const url = markdownScalar(frontmatter, 'source_url');
  const platform = markdownScalar(frontmatter, 'source');
  return url && ['x', 'threads'].includes(platform)
    ? normalizeCrossPostSources([{
      platform,
      url,
      publishedAt: markdownScalar(frontmatter, 'created'),
      externalKey: postIdentity(url) || url
    }])
    : [];
}

function markdownPostItems(markdown) {
  const match = /\n## (?:貼文內容|串文內容)\r?\n\r?\n([\s\S]*?)(?=\r?\n\r?\n---\r?\n\r?\n(?:## 圖片|> \[!quote\]|> \[!info\] 接續)|\s*$)/.exec(String(markdown || ''));
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const items = [];
  for (let index = 0; index < lines.length; index++) {
    const fence = /^(`{3,})$/.exec(lines[index]);
    if (!fence) continue;
    const content = [];
    index++;
    while (index < lines.length && lines[index] !== fence[1]) content.push(lines[index++]);
    items.push(content.join('\n'));
  }
  return items;
}

function markdownManualSections(markdown) {
  const body = String(markdown || '').replace(markdownFrontmatter(markdown)?.[0] || '', '').trim();
  return body.split(/\r?\n\r?\n---\r?\n\r?\n/).filter((section) => {
    const value = section.trim();
    return value
      && !value.startsWith('> [!info] 貼文資訊')
      && !value.startsWith('## 貼文內容')
      && !value.startsWith('## 串文內容')
      && !value.startsWith('## 圖片')
      && !value.startsWith('> [!quote]')
      && !value.startsWith('> [!info] 接續');
  }).map(section => section.trim());
}

function markdownImageLinks(markdown) {
  return [...String(markdown || '').matchAll(/^!\[([^\n]*)\]\(<([^>]+)>\)$/gm)]
    .map(match => ({ alt: match[1], target: match[2].replace(/%3E/gi, '>') }));
}

async function parseMarkdownPostRecord(markdown, ref) {
  const frontmatterMatch = markdownFrontmatter(markdown);
  if (!frontmatterMatch) return null;
  const frontmatter = frontmatterMatch[1];
  if (markdownScalar(frontmatter, 'status') !== 'published') return null;
  if (markdownScalar(frontmatter, 'reply_to') || markdownScalar(frontmatter, 'quoted_url')
    || markdownScalar(frontmatter, 'quoted_from')) return null;
  const sources = markdownSources(frontmatter);
  if (!sources.length) return null;
  const items = markdownPostItems(markdown);
  const normalized = items.join(' ').replace(/\s+/gu, ' ').trim();
  if (!normalized) return null;
  const fingerprint = `sha256:${await sha256Hex(normalized)}`;
  return {
    ref,
    title: markdownScalar(frontmatter, 'title') || ref.title || noteBasename(ref.path),
    createdAt: markdownScalar(frontmatter, 'created') || sources[0].publishedAt || '',
    fingerprint,
    platforms: [...new Set(sources.map(source => source.platform))],
    sources,
    revision: `sha256:${await sha256Hex(String(markdown || ''))}`,
    manualSections: markdownManualSections(markdown),
    images: markdownImageLinks(markdown)
  };
}

function crossPostFrontmatterLines(fingerprint, sources) {
  const normalized = normalizeCrossPostSources(sources);
  const platforms = [...new Set(normalized.map(source => platformDisplayName(source.platform)))];
  return [
    `content_fingerprint: ${escapeYaml(fingerprint)}`,
    'platforms:',
    ...platforms.map(platform => `  - ${escapeYaml(platform)}`),
    'sources:',
    ...normalized.flatMap(source => [
      `  - platform: ${escapeYaml(source.platform)}`,
      `    url: ${escapeYaml(source.url)}`,
      `    published_at: ${escapeYaml(source.publishedAt)}`,
      `    external_key: ${escapeYaml(source.externalKey)}`
    ])
  ];
}

function replaceCrossPostFrontmatter(markdown, fingerprint, sources) {
  const match = markdownFrontmatter(markdown);
  if (!match) throw new Error('既有筆記缺少 YAML frontmatter，無法安全合併');
  const lines = match[1].split(/\r?\n/);
  const retained = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^(?:content_fingerprint|platforms|sources):/.test(lines[index])) {
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) index++;
      continue;
    }
    retained.push(lines[index]);
  }
  const insertAt = Math.max(0, retained.findIndex(line => line.startsWith('source_url:')) + 1);
  retained.splice(insertAt, 0, ...crossPostFrontmatterLines(fingerprint, sources));
  const platformNames = [...new Set(normalizeCrossPostSources(sources).map(source => platformDisplayName(source.platform)))];
  const tagsAt = retained.findIndex(line => line === 'tags:');
  if (tagsAt >= 0) {
    let tagsEnd = tagsAt + 1;
    while (tagsEnd < retained.length && /^\s+-\s+/.test(retained[tagsEnd])) tagsEnd++;
    const tags = retained.slice(tagsAt + 1, tagsEnd).map(line => markdownScalar(`tag: ${line.replace(/^\s+-\s+/, '')}`, 'tag'));
    for (const platform of platformNames) {
      if (!tags.includes(platform)) retained.splice(tagsEnd++, 0, `  - ${escapeYaml(platform)}`);
    }
  }
  return String(markdown).replace(match[0], `---\n${retained.join('\n')}\n---\n`);
}

function replaceCrossPostInfo(markdown, sources) {
  const normalized = normalizeCrossPostSources(sources);
  const platforms = [...new Set(normalized.map(source => platformDisplayName(source.platform)))];
  const existing = /> \[!info\] 貼文資訊\r?\n([\s\S]*?)(?=\r?\n\r?\n---\r?\n\r?\n)/.exec(markdown);
  if (!existing) throw new Error('既有筆記缺少貼文資訊區塊，無法安全合併');
  const type = /^> \*\*類型\*\*：.*$/m.exec(existing[0])?.[0];
  const time = /^> \*\*發佈時間\*\*：.*$/m.exec(existing[0])?.[0];
  const lines = [
    '> [!info] 貼文資訊',
    `> **平台**：${platforms.join('、')}  `,
    ...(type ? [type.endsWith('  ') ? type : `${type}  `] : []),
    ...(time ? [time.endsWith('  ') ? time : `${time}  `] : []),
    ...normalized.map((source, index) => (
      `> **原始貼文${normalized.length > 1 ? ` ${index + 1}` : ''}**：[在 ${platformDisplayName(source.platform)} 查看](<${markdownLinkTarget(source.url)}>)${index < normalized.length - 1 ? '  ' : ''}`
    ))
  ];
  return markdown.replace(existing[0], lines.join('\n'));
}

function appendMergedManualSections(markdown, records) {
  const sections = records.flatMap(record => (record.manualSections || []).map(section => ({ record, section })));
  if (!sections.length) return markdown;
  const existing = new Set(markdownManualSections(markdown));
  const additions = sections.filter(item => !existing.has(item.section));
  if (!additions.length) return markdown;
  const body = additions.map(({ record, section }) => (
    `### 來自「${record.title}」（${record.createdAt || '時間不明'}）\n\n${section}`
  )).join('\n\n');
  const heading = markdown.includes('\n## 合併保留內容\n') ? '' : '## 合併保留內容\n\n';
  return `${markdown.replace(/\s*$/, '')}\n\n---\n\n${heading}${body}\n`;
}

function appendMergedImages(markdown, mediaResults) {
  if (!mediaResults.length) return markdown;
  const imageMarkdown = mediaResults.map(item => (
    `![${escapeMarkdownAlt(item.alt)}](<${markdownLinkTarget(item.path || item.url)}>)`
  )).join('\n\n');
  const imageSection = /\n## 圖片\n\n([\s\S]*?)(?=\n\n---\n\n|\s*$)/.exec(markdown);
  if (imageSection) {
    const replacement = `${imageSection[0].replace(/\s*$/, '')}\n\n${imageMarkdown}`;
    return markdown.replace(imageSection[0], replacement);
  }
  return `${markdown.replace(/\s*$/, '')}\n\n---\n\n## 圖片\n\n${imageMarkdown}\n`;
}

function mergeCrossPlatformMarkdown(markdown, fingerprint, sources, duplicateRecords = [], mediaResults = []) {
  let result = replaceCrossPostFrontmatter(markdown, fingerprint, sources);
  result = replaceCrossPostInfo(result, sources);
  result = appendMergedManualSections(result, duplicateRecords);
  result = appendMergedImages(result, mediaResults);
  return result.replace(/\s*$/, '\n');
}

// expectedUrls：這則回覆應該接上的母貼文 URL。用 frontmatter 的 source_url 核對，
// 確認手上這份 Markdown 真的是目標筆記——路徑可能被使用者搬動或換檔，光憑路徑不夠。
function appendPostToMarkdown(markdown, data, mediaResults = [], expectedUrls = []) {
  let result = String(markdown || '');
  const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(result);
  if (!frontmatterMatch) throw new Error('既有筆記缺少 YAML frontmatter，無法安全合併');

  const sourceUrlMatch = /^source_url:\s*["']?([^"'\n]+)["']?\s*$/m.exec(frontmatterMatch[1]);
  const sourceIdentity = postIdentity(sourceUrlMatch?.[1]);
  const wanted = (Array.isArray(expectedUrls) ? expectedUrls : [])
    .map(postIdentity)
    .filter(Boolean);
  // 對得上＝確定是母筆記；對不上＝這份檔案已不是我們要接的貼文，不能亂接
  const anchored = !!sourceIdentity && wanted.includes(sourceIdentity);
  if (sourceIdentity && wanted.length && !anchored) {
    throw new Error('既有筆記的 source_url 與被回覆的貼文不符，無法安全合併');
  }

  const frontmatterLines = frontmatterMatch[1].split('\n');
  const existingCountLine = frontmatterLines.findIndex(line => /^thread_count:/.test(line));
  const existingCount = existingCountLine >= 0
    ? Number(frontmatterLines[existingCountLine].split(':')[1])
    : ((result.match(/^### \d+ \/ \d+$/gm) || []).length || 1);
  const newItems = getThreadItems(data).length ? getThreadItems(data) : [String(data.content || '')];
  const total = existingCount + newItems.length;

  const typeLine = frontmatterLines.findIndex(line => /^post_type:/.test(line));
  if (typeLine >= 0) frontmatterLines[typeLine] = `post_type: ${escapeYaml('thread')}`;
  else frontmatterLines.splice(frontmatterLines.findIndex(line => /^tags:/.test(line)), 0, `post_type: ${escapeYaml('thread')}`);
  const countLine = frontmatterLines.findIndex(line => /^thread_count:/.test(line));
  if (countLine >= 0) frontmatterLines[countLine] = `thread_count: ${total}`;
  else frontmatterLines.splice(frontmatterLines.findIndex(line => /^tags:/.test(line)), 0, `thread_count: ${total}`);
  const tagsLine = frontmatterLines.findIndex(line => /^tags:/.test(line));
  let tagsEnd = tagsLine + 1;
  while (tagsEnd < frontmatterLines.length && /^\s+-\s+/.test(frontmatterLines[tagsEnd])) tagsEnd++;
  if (!frontmatterLines.slice(tagsLine + 1, tagsEnd).some(line => /["']?串文["']?\s*$/.test(line))) {
    frontmatterLines.splice(tagsEnd, 0, `  - ${escapeYaml('串文')}`);
  }
  result = result.replace(frontmatterMatch[0], `---\n${frontmatterLines.join('\n')}\n---`);
  result = result.replace(/^> \*\*類型\*\*：.*?  $/m, '> **類型**：串文  ');

  const appended = newItems.map((item, index) => (
    `### ${existingCount + index + 1} / ${total}\n\n${renderCopyableContent(item)}`
  ));

  const headingMatch = /\n## (?:貼文內容|串文內容)\n\n/.exec(result);
  if (headingMatch) {
    const sectionStart = headingMatch.index + 1;
    const bodyStart = headingMatch.index + headingMatch[0].length;
    const trailing = result.slice(bodyStart).search(/\n\n---\n\n(?=## 圖片|> \[!quote\])/);
    const sectionEnd = trailing >= 0 ? bodyStart + trailing : result.replace(/\n+$/, '').length;
    let existingBody = result.slice(bodyStart, sectionEnd);
    if (existingCount === 1 && !/^### 1 \/ /m.test(existingBody)) {
      existingBody = `### 1 / ${total}\n\n${existingBody}`;
    } else {
      existingBody = existingBody.replace(/^### (\d+) \/ \d+$/gm, `### $1 / ${total}`);
    }
    const contentSection = `## 串文內容\n\n${existingBody}\n\n---\n\n${appended.join('\n\n---\n\n')}`;
    result = result.slice(0, sectionStart) + contentSection + result.slice(sectionEnd);
  } else if (anchored) {
    // 母筆記被手動編輯過、找不到原本的內容區塊，但 source_url 已確認這就是要接的
    // 那一篇，所以不放棄合併，改接在檔尾——寧可格式不完美，也不要讓回覆消失。
    result = `${result.replace(/\n+$/, '')}\n\n---\n\n${appended.join('\n\n---\n\n')}\n`;
  } else {
    // 既認不出身分又找不到內容區塊：交給呼叫端另存新檔，不冒險亂接
    throw new Error('既有筆記缺少貼文內容區塊，無法安全合併');
  }

  if (mediaResults.length) {
    const mediaMarkdown = mediaResults.map((item) => {
      const target = item.failed ? item.url : item.path;
      return `![${escapeMarkdownAlt(item.alt)}](<${markdownLinkTarget(target)}>)`;
    }).join('\n\n');
    const mediaHeading = /\n## 圖片\n\n/.exec(result);
    if (mediaHeading) {
      const mediaBodyStart = mediaHeading.index + mediaHeading[0].length;
      const mediaTrailing = result.slice(mediaBodyStart).search(/\n\n---\n\n(?=> \[!quote\])/);
      const mediaEnd = mediaTrailing >= 0 ? mediaBodyStart + mediaTrailing : result.replace(/\n+$/, '').length;
      result = `${result.slice(0, mediaEnd)}\n\n${mediaMarkdown}${result.slice(mediaEnd)}`;
    } else {
      const quoteBoundary = result.search(/\n\n---\n\n(?=> \[!quote\])/);
      const insertAt = quoteBoundary >= 0 ? quoteBoundary : result.replace(/\n+$/, '').length;
      result = `${result.slice(0, insertAt)}\n\n---\n\n## 圖片\n\n${mediaMarkdown}${result.slice(insertAt)}`;
    }
  }

  return result.replace(/\n*$/, '\n');
}

function markdownLinkTarget(target) {
  return String(target || '').replace(/>/g, '%3E');
}

// 產生草稿 Markdown 內容
function generateDraftMarkdown(data) {
  const platformName = platformDisplayName(data.platform);
  const updated = formatDateTime(data.timestamp);
  const threadItems = getThreadItems(data);
  const frontmatter = [
    '---',
    `title: ${escapeYaml(`${platformName} 草稿`)}`,
    `updated: ${escapeYaml(updated)}`,
    `platform: ${escapeYaml(platformName)}`,
    `source: ${escapeYaml(data.platform)}`,
    `status: ${escapeYaml('draft')}`,
    ...(threadItems.length > 1 ? [`thread_count: ${threadItems.length}`] : []),
    'tags:',
    `  - ${escapeYaml('社群草稿')}`,
    `  - ${escapeYaml(platformName)}`,
    ...(threadItems.length > 1 ? [`  - ${escapeYaml('串文')}`] : []),
    '---'
  ].join('\n');
  const notice = [
    '> [!warning] 未發佈草稿',
    `> **平台**：${platformName}  `,
    `> **最後更新**：${updated}  `,
    '> 發佈成功後，這份草稿檔會自動移除。'
  ].join('\n');

  return `${frontmatter}\n\n${notice}\n\n${renderContentSection(
    data,
    '草稿內容',
    '串文草稿'
  )}\n`;
}

// Generate Markdown with media, reply, and quote metadata.
function generateMarkdown(data, mediaResults = [], threadRoot = '') {
  const threadItems = getThreadItems(data);
  const category = classifyPost(data);
  const title = extractTitle(threadItems[0] || data.content || '圖片貼文');
  const created = formatDateTime(data.timestamp);
  const platformName = platformDisplayName(data.platform);
  const sources = normalizeCrossPostSources(data.sources?.length ? data.sources : [sourceForPost(data)]);
  const platforms = [...new Set(sources.map(source => platformDisplayName(source.platform)))];
  const frontmatter = [
    '---',
    `title: ${escapeYaml(title)}`,
    `created: ${escapeYaml(created)}`,
    `platform: ${escapeYaml(platformName)}`,
    `source: ${escapeYaml(data.platform)}`,
    `source_url: ${escapeYaml(data.url)}`,
    ...(data.contentFingerprint ? [`content_fingerprint: ${escapeYaml(data.contentFingerprint)}`] : []),
    ...(data.contentFingerprint ? [
      'platforms:',
      ...platforms.map(platform => `  - ${escapeYaml(platform)}`),
      'sources:',
      ...sources.flatMap(source => [
        `  - platform: ${escapeYaml(source.platform)}`,
        `    url: ${escapeYaml(source.url)}`,
        `    published_at: ${escapeYaml(source.publishedAt)}`,
        `    external_key: ${escapeYaml(source.externalKey)}`
      ])
    ] : []),
    `status: ${escapeYaml('published')}`,
    ...(category ? [`post_type: ${escapeYaml(category.type)}`] : []),
    ...(threadItems.length > 1 ? [`thread_count: ${threadItems.length}`] : [])
  ];

  // 如果是回覆，記下被回覆的貼文連結
  if (data.replyTo) {
    frontmatter.push(`reply_to: ${escapeYaml(data.replyTo)}`);
  }

  // 本該合併進母筆記、但母筆記已無法安全接續時，留下指回去的線索
  if (threadRoot) {
    frontmatter.push(`thread_root: ${escapeYaml(`[[${noteStem(threadRoot)}]]`)}`);
  }

  // 如果有引用，加入引用資訊
  if (data.quoted) {
    frontmatter.push(
      `quoted_from: ${escapeYaml('@' + data.quoted.author)}`,
      `quoted_author_name: ${escapeYaml(data.quoted.authorName)}`,
      `quoted_url: ${escapeYaml(data.quoted.url)}`
    );
  }

  const tags = ['社群貼文', ...(platforms.length ? platforms : [platformName])];
  if (category) tags.push(category.label);
  if (threadItems.length > 1 && !tags.includes('串文')) tags.push('串文');
  if (data.quoted && !tags.includes('引用')) tags.push('引用');
  if (data.replyTo && !tags.includes('回覆') && category?.type !== 'thread') tags.push('回覆');
  frontmatter.push(
    'tags:',
    ...tags.map(tag => `  - ${escapeYaml(tag)}`),
    `summary: ${escapeYaml('')}`,
    '---'
  );

  const info = [
    '> [!info] 貼文資訊',
    `> **平台**：${platforms.join('、') || platformName}  `,
    ...(category ? [`> **類型**：${category.label}  `] : []),
    `> **發佈時間**：${created}${data.url || data.replyTo ? '  ' : ''}`,
    ...sources.map((source, index) => (
      `> **原始貼文${sources.length > 1 ? ` ${index + 1}` : ''}**：[在 ${platformDisplayName(source.platform)} 查看](<${markdownLinkTarget(source.url)}>)${data.replyTo || index < sources.length - 1 ? '  ' : ''}`
    )),
    ...(data.replyTo ? [
      `> **回覆對象**：[查看原始貼文](<${markdownLinkTarget(data.replyTo)}>)`
    ] : [])
  ].join('\n');
  const sections = [info];

  if (threadRoot) {
    sections.push(`> [!info] 接續 [[${noteStem(threadRoot)}]]\n> 母筆記格式已變更，無法自動合併，這則回覆另存為新檔。`);
  }

  if (data.content || threadItems.length > 0) {
    sections.push(renderContentSection(data, '貼文內容', '串文內容'));
  }

  if (mediaResults.length > 0) {
    sections.push(`## 圖片\n\n${mediaResults.map((item) => {
      const alt = escapeMarkdownAlt(item.alt);
      const target = item.failed ? item.url : item.path;
      return `![${alt}](<${markdownLinkTarget(target)}>)`;
    }).join('\n\n')}`);
  }

  // 如果有引用，加入引用區塊
  if (data.quoted && data.quoted.content) {
    const quotedAuthor = data.quoted.url
      ? `[@${data.quoted.author}](<${markdownLinkTarget(data.quoted.url)}>)`
      : `@${data.quoted.author}`;
    // 引用內容由他人撰寫：逸出會觸發遠端抓取或注入的 Markdown/HTML 構件
    // （圖片、連結、HTML、Obsidian 嵌入、code span），同時保留 callout 散文外觀
    const quotedLines = escapeQuotedMarkdown(data.quoted.content)
      .split('\n')
      .map(line => '> ' + line)
      .join('\n');
    sections.push(`> [!quote] 引用貼文\n> ${quotedAuthor}\n>\n${quotedLines}`);
  }

  return `${frontmatter.join('\n')}\n\n${sections.join('\n\n---\n\n')}\n`;
}

// 擷取標題（首句，最多 30 字）
function extractTitle(content) {
  // 移除換行後以 code point 切割，避免把 emoji 的 surrogate pair 切成半個字
  const chars = Array.from(content.replace(/\n/g, ' ').trim());
  const title = chars.slice(0, 30).join('');

  // 如果有截斷，加上 ...
  return chars.length > 30 ? title + '...' : title;
}

// 產生檔案名稱
function generateFilename(data) {
  const date = new Date(data.timestamp);
  const dateStr = formatDate(date);
  // 加上時分，避免同一天發相似開頭的貼文時檔名互相覆蓋
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  // 取首 25 字作為摘要（以 code point 切割避免切斷 emoji），移除不合法的檔名字元
  const summary = Array.from((data.content || '圖片貼文').replace(/\n/g, ' '))
    .slice(0, 25)
    .join('')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim();

  // 內容全是不合法檔名字元時摘要會變空字串，補上 fallback 避免產生「_.md」結尾的檔名
  return `${dateStr}_${hours}${minutes}_${summary || '貼文'}.md`;
}

function escapeMarkdownAlt(text) {
  return String(text || '圖片').replace(/[\[\]\\]/g, '\\$&');
}

// 逸出他人撰寫的引用內容：中和圖片／連結／HTML／Obsidian 嵌入／code span，
// 保留 callout 散文外觀（裸網址仍會被 Obsidian 自動連結，屬可接受風險）
function escapeQuotedMarkdown(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`\[\]]/g, '\\$&');
}

// 格式化日期時間 (YYYY-MM-DD HH:mm)
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// 格式化日期 (YYYY-MM-DD)
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

// 跳脫 YAML 特殊字元
function escapeYaml(str) {
  // JSON 字串也是合法的 YAML 雙引號字串，可避免日期、yes/no 等值被推斷成其他型別。
  return JSON.stringify(String(str ?? ''));
}

// 依 port 決定協定（27124 是 Local REST API 的 HTTPS 埠）
function apiBase(port) {
  const protocol = Number(port) === 27124 ? 'https' : 'http';
  return `${protocol}://127.0.0.1:${port}`;
}

async function saveVaultFile(content, filename, settings, contentType, mtime) {
  if (resolveStorageMode(settings) === 'native') {
    try {
      const binary = typeof content !== 'string';
      await sendNativeRequest({
        action: 'write',
        path: filename,
        encoding: binary ? 'base64' : 'utf8',
        data: binary ? arrayBufferToBase64(content) : content,
        // 補存舊貼文時，檔案時間要對齊發文時間，依修改時間排序才不會全擠在最新
        mtime: mtime || undefined
      });
      return;
    } catch (error) {
      // 可否進離線佇列由 sendNativeRequest 的分類決定（Host 不可用才標 isStorageUnavailableError）
      error.isVaultWriteError = true;
      throw error;
    }
  }
  return saveFileToObsidian(content, filename, settings.apiKey, settings.port || 27123, contentType);
}

function arrayBufferToBase64(content) {
  const bytes = new Uint8Array(content);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

async function saveFileToObsidian(content, filename, apiKey, port, contentType) {
  const url = `${apiBase(port)}/vault/${encodeURIComponent(filename)}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': contentType
      },
      body: content
    });
  } catch (error) {
    error.isObsidianApiError = true;
    error.isObsidianConnectionError = true;
    throw error;
  }

  // 204 No Content 也算成功
  if (!response.ok && response.status !== 204) {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const error = await response.json();
      errorMessage = error.message || errorMessage;
    } catch {
      // 忽略 JSON 解析錯誤
    }
    const error = new Error(errorMessage);
    error.isObsidianApiError = true;
    throw error;
  }
}

// 顯示通知
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message
  });
}
