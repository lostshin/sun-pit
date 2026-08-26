const apiKeyInput = document.getElementById('apiKey');
const portInput = document.getElementById('port');
const basePathInput = document.getElementById('basePath');
const mediaPathInput = document.getElementById('mediaPath');
const storageProviderSelect = document.getElementById('storageProvider');
const markdownSettingsPanel = document.getElementById('markdownSettings');
const notesSettingsPanel = document.getElementById('notesSettings');
const restSettingsPanel = document.getElementById('restSettings');
const commonPathGroup = document.getElementById('commonPathGroup');
const notesLocationSelect = document.getElementById('notesLocation');
const refreshNotesBtn = document.getElementById('refreshNotesBtn');
const httpWarning = document.getElementById('httpWarning');
const chooseFolderBtn = document.getElementById('chooseFolderBtn');
const vaultName = document.getElementById('vaultName');
const nativeSetupHelp = document.getElementById('nativeSetupHelp');
const nativeSetupMessage = document.getElementById('nativeSetupMessage');
const nativeSetupHint = document.getElementById('nativeSetupHint');
const settingsPanel = document.getElementById('settingsPanel');
const settingsForm = document.getElementById('settingsForm');
const toggleApiKey = document.getElementById('toggleApiKey');
const testBtn = document.getElementById('testBtn');
const statusDiv = document.getElementById('status');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');
const queueInfo = document.getElementById('queueInfo');
const actionStatus = document.getElementById('actionStatus');
const draftSection = document.getElementById('draftSection');
const draftList = document.getElementById('draftList');
const clearDraftsBtn = document.getElementById('clearDraftsBtn');
const recentList = document.getElementById('recentList');
const previewPopover = document.getElementById('previewPopover');
const previewText = document.getElementById('previewText');
const duplicateScanBtn = document.getElementById('duplicateScanBtn');
const duplicateMergeBtn = document.getElementById('duplicateMergeBtn');
const duplicateStatus = document.getElementById('duplicateStatus');
const duplicateResults = document.getElementById('duplicateResults');

let actionStatusTimer;
let activePreviewAnchor;
let loadedSettings = {};
let notesLocationsPromise;
let connectionRequestId = 0;
let duplicateScanId = '';
const NOTES_LOCATIONS_CACHE_KEY = 'appleNotesLocationsCache';

function readPort() {
  const enteredPort = Number.parseInt(portInput.value, 10);
  return Number.isInteger(enteredPort) ? enteredPort : 27123;
}

function providerLabel(provider) {
  if (provider === STORAGE_PROVIDERS.APPLE_NOTES) return 'Apple 備忘錄';
  if (provider === STORAGE_PROVIDERS.OBSIDIAN_REST) return 'Obsidian Local REST API';
  return '本機 Markdown 資料夾';
}

function activePathSettings() {
  return storageProviderSelect.value === STORAGE_PROVIDERS.OBSIDIAN_REST
    ? loadedSettings.obsidianRestSettings || {}
    : loadedSettings.markdownFolderSettings || {};
}

function updateModeUI(loadPaths = false) {
  const provider = storageProviderSelect.value;
  const markdown = provider === STORAGE_PROVIDERS.MARKDOWN_FOLDER;
  const notes = provider === STORAGE_PROVIDERS.APPLE_NOTES;
  markdownSettingsPanel.hidden = !markdown;
  notesSettingsPanel.hidden = !notes;
  restSettingsPanel.hidden = provider !== STORAGE_PROVIDERS.OBSIDIAN_REST;
  commonPathGroup.hidden = notes;
  testBtn.textContent = markdown ? '檢查 Helper' : notes ? '檢查備忘錄' : '測試連線';
  if (loadPaths && !notes) {
    const paths = activePathSettings();
    basePathInput.value = paths.basePath || DEFAULT_BASE_PATH;
    mediaPathInput.value = paths.mediaPath || DEFAULT_MEDIA_PATH;
  }
  updateHttpWarning();
}

function updateHttpWarning() {
  httpWarning.hidden = !(storageProviderSelect.value === STORAGE_PROVIDERS.OBSIDIAN_REST && readPort() !== 27124);
}

function updateNativeSetupHelp(status) {
  const needsUpdate = status?.code === 'NATIVE_HOST_UPDATE_REQUIRED';
  const needsSetup = needsUpdate
    || status?.code === 'NATIVE_HOST_NOT_FOUND'
    || status?.code === 'NATIVE_HOST_FORBIDDEN';
  nativeSetupHelp.hidden = !needsSetup;
  if (!needsSetup) return;
  if (needsUpdate) {
    nativeSetupMessage.textContent = 'Helper 版本需要更新';
    nativeSetupHint.textContent = '重新執行最新版 Helper 安裝程式，再重新載入擴充功能。';
    return;
  }
  nativeSetupMessage.textContent = status.code === 'NATIVE_HOST_FORBIDDEN'
    ? 'Helper 需要更新授權'
    : '還差一步：安裝本機 Helper';
  nativeSetupHint.textContent = status.code === 'NATIVE_HOST_FORBIDDEN'
    ? '重新執行最新版 Helper 安裝程式，再回到這裡檢查。'
    : '下載同版本的 macOS Helper 並執行安裝程式，再回到這裡檢查。';
}

function notesLocationValue(location) {
  return location?.accountId && location?.folderId
    ? `${location.accountId}\u001f${location.folderId}`
    : '';
}

function renderNotesLocations(locations, selected, emptyText = '尚未載入') {
  const available = Array.isArray(locations)
    ? locations.filter(location => notesLocationValue(location))
    : [];
  const signature = JSON.stringify(available.map(location => [
    location.accountId,
    location.accountName,
    location.folderId,
    location.folderName
  ])) + (available.length ? '' : `:${emptyText}`);
  const selectedValue = notesLocationValue(selected);

  if (notesLocationSelect.dataset.locationsSignature === signature) {
    if ([...notesLocationSelect.options].some(option => option.value === selectedValue)) {
      notesLocationSelect.value = selectedValue;
    }
    notesLocationSelect.disabled = available.length === 0;
    return;
  }

  notesLocationSelect.textContent = '';
  if (!available.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyText;
    notesLocationSelect.appendChild(option);
  }
  for (const location of available) {
    const option = document.createElement('option');
    option.value = notesLocationValue(location);
    option.textContent = `${location.accountName} › ${location.folderName}`;
    option.dataset.accountId = location.accountId;
    option.dataset.accountName = location.accountName;
    option.dataset.folderId = location.folderId;
    option.dataset.folderName = location.folderName;
    notesLocationSelect.appendChild(option);
  }
  notesLocationSelect.dataset.locationsSignature = signature;
  if ([...notesLocationSelect.options].some(option => option.value === selectedValue)) {
    notesLocationSelect.value = selectedValue;
  }
  notesLocationSelect.disabled = available.length === 0;
}

async function loadNotesLocations(selected = loadedSettings.appleNotesSettings) {
  if (notesLocationsPromise) return notesLocationsPromise;
  notesLocationsPromise = (async () => {
    const hadLocations = [...notesLocationSelect.options].some(option => option.value);
    if (!hadLocations) notesLocationSelect.disabled = true;
    refreshNotesBtn.disabled = true;
    refreshNotesBtn.textContent = '更新中…';
    refreshNotesBtn.setAttribute('aria-busy', 'true');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LIST_NOTES_LOCATIONS' });
      updateNativeSetupHelp(response);
      if (!response?.ok) throw new Error(response?.error || '無法讀取 Apple 備忘錄資料夾');
      const cache = { locations: response.locations || [], fetchedAt: Date.now() };
      await chrome.storage.local.set({ [NOTES_LOCATIONS_CACHE_KEY]: cache });
      loadedSettings[NOTES_LOCATIONS_CACHE_KEY] = cache;
      renderNotesLocations(cache.locations, selected, '找不到可用資料夾');
    } catch (error) {
      if (!hadLocations) renderNotesLocations([], selected, '無法載入資料夾');
      if (storageProviderSelect.value === STORAGE_PROVIDERS.APPLE_NOTES) showStatus(error.message, 'error');
    } finally {
      refreshNotesBtn.disabled = false;
      refreshNotesBtn.textContent = '重新載入';
      refreshNotesBtn.removeAttribute('aria-busy');
    }
  })();
  try {
    return await notesLocationsPromise;
  } finally {
    notesLocationsPromise = null;
  }
}

async function loadSettings() {
  loadedSettings = await chrome.storage.local.get([
    'storageProvider',
    'markdownFolderSettings',
    'obsidianRestSettings',
    'appleNotesSettings',
    NOTES_LOCATIONS_CACHE_KEY
  ]);
  storageProviderSelect.value = resolveStorageProvider(loadedSettings);
  const markdown = loadedSettings.markdownFolderSettings || {};
  const rest = loadedSettings.obsidianRestSettings || {};
  apiKeyInput.value = rest.apiKey || '';
  portInput.value = rest.port || 27123;
  vaultName.textContent = markdown.folderName || '尚未選擇';
  updateModeUI(true);
  const selectedNotes = loadedSettings.appleNotesSettings || {};
  const cachedLocations = loadedSettings[NOTES_LOCATIONS_CACHE_KEY]?.locations;
  const initialLocations = Array.isArray(cachedLocations) && cachedLocations.length
    ? cachedLocations
    : notesLocationValue(selectedNotes)
      ? [selectedNotes]
      : [];
  renderNotesLocations(initialLocations, selectedNotes);
  const active = storageProviderSelect.value;
  settingsPanel.open = active === STORAGE_PROVIDERS.MARKDOWN_FOLDER
    ? !markdown.folderName
    : active === STORAGE_PROVIDERS.APPLE_NOTES
      ? !loadedSettings.appleNotesSettings?.folderId
      : !rest.apiKey;
  if (active === STORAGE_PROVIDERS.APPLE_NOTES && !initialLocations.length) {
    void loadNotesLocations(selectedNotes);
  }
}

function selectedNotesLocation() {
  const option = notesLocationSelect.selectedOptions[0];
  if (!option?.value) return null;
  return {
    accountId: option.dataset.accountId,
    accountName: option.dataset.accountName,
    folderId: option.dataset.folderId,
    folderName: option.dataset.folderName
  };
}

async function saveSettings() {
  const provider = storageProviderSelect.value;
  const basePath = basePathInput.value.trim() || DEFAULT_BASE_PATH;
  const mediaPath = mediaPathInput.value.trim() || DEFAULT_MEDIA_PATH;
  const updates = { storageProvider: provider };

  if (provider === STORAGE_PROVIDERS.MARKDOWN_FOLDER) {
    const response = await chrome.runtime.sendMessage({ type: 'GET_NATIVE_STATUS' });
    updateNativeSetupHelp(response);
    if (!response?.ok || !response?.configured) {
      showStatus(response?.error || '請先安裝 Helper 並選擇資料夾', 'error');
      return;
    }
    updates.markdownFolderSettings = {
      ...(loadedSettings.markdownFolderSettings || {}),
      basePath,
      mediaPath,
      folderName: response.folderName || response.vaultName,
      isObsidianVault: response.isObsidianVault === true
    };
  } else if (provider === STORAGE_PROVIDERS.OBSIDIAN_REST) {
    const apiKey = apiKeyInput.value.trim();
    const port = readPort();
    if (!apiKey) return showStatus('請輸入 API Key', 'error');
    if (port < 1 || port > 65535) return showStatus('Port 必須介於 1 到 65535', 'error');
    updates.obsidianRestSettings = { apiKey, port, basePath, mediaPath };
  } else {
    const location = selectedNotesLocation();
    if (!location) return showStatus('請選擇 Apple 備忘錄的帳號與資料夾', 'error');
    updates.appleNotesSettings = location;
  }

  await chrome.storage.local.set(updates);
  loadedSettings = { ...loadedSettings, ...updates };
  showStatus('設定已儲存', 'success');
  await checkConnection();
  chrome.runtime.sendMessage({ type: 'RETRY_QUEUE' });
}

async function chooseFolder() {
  chooseFolderBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CHOOSE_NATIVE_VAULT' });
    updateNativeSetupHelp(response);
    if (!response?.ok) throw new Error(response?.error || '本機 Helper 無法選擇資料夾');
    storageProviderSelect.value = STORAGE_PROVIDERS.MARKDOWN_FOLDER;
    loadedSettings.storageProvider = STORAGE_PROVIDERS.MARKDOWN_FOLDER;
    loadedSettings.markdownFolderSettings = {
      ...(loadedSettings.markdownFolderSettings || {}),
      folderName: response.folderName || response.vaultName,
      isObsidianVault: response.isObsidianVault === true
    };
    vaultName.textContent = response.folderName || response.vaultName;
    updateModeUI(true);
    showStatus(`已選擇：${vaultName.textContent}`, 'success');
    await checkConnection();
  } catch (error) {
    showStatus(`無法選擇資料夾 · ${error.message}`, 'error');
  } finally {
    chooseFolderBtn.disabled = false;
  }
}

async function testConnection() {
  testBtn.disabled = true;
  showStatus('正在檢查…', 'info');
  try {
    await saveSettings();
  } finally {
    testBtn.disabled = false;
    updateModeUI();
  }
}

function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
}

function clearProviderStatus() {
  statusDiv.textContent = '';
  statusDiv.className = 'status';
  clearTimeout(actionStatusTimer);
  actionStatus.textContent = '';
  actionStatus.className = 'status global-status';
}

function showActionStatus(message, type) {
  clearTimeout(actionStatusTimer);
  actionStatus.textContent = message;
  actionStatus.className = `status global-status ${type}`;
  actionStatusTimer = setTimeout(() => { actionStatus.className = 'status global-status'; }, 3500);
}

function renderStoredConnectionStatus() {
  const provider = resolveStorageProvider(loadedSettings);
  if (provider !== STORAGE_PROVIDERS.APPLE_NOTES) {
    connDot.className = 'dot';
    connText.textContent = '準備檢查連線…';
    return;
  }
  const notes = loadedSettings.appleNotesSettings || {};
  if (notes.accountId && notes.folderId) {
    connDot.className = 'dot ready';
    connText.textContent = `Apple 備忘錄已設定 · ${notes.folderName || notes.accountName}`;
  } else {
    connDot.className = 'dot fail';
    connText.textContent = '尚未選擇 Apple 備忘錄資料夾';
  }
}

async function checkConnection() {
  const requestId = ++connectionRequestId;
  const expectedProvider = resolveStorageProvider(loadedSettings);
  const isCurrentRequest = () => (
    requestId === connectionRequestId
    && resolveStorageProvider(loadedSettings) === expectedProvider
  );
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STORAGE_STATUS' });
    if (!isCurrentRequest() || (response?.provider && response.provider !== expectedProvider)) return;
    updateNativeSetupHelp(response);
    connDot.className = response?.ok && response?.configured !== false ? 'dot ok' : 'dot fail';
    if (!response?.ok) {
      connText.textContent = response?.error || `${providerLabel(response?.provider)}無法使用`;
    } else if (response.provider === STORAGE_PROVIDERS.MARKDOWN_FOLDER) {
      connText.textContent = response.configured
        ? `本機資料夾已連線 · ${response.folderName || response.vaultName}`
        : '尚未選擇 Markdown 資料夾';
      if (response.folderName || response.vaultName) vaultName.textContent = response.folderName || response.vaultName;
    } else if (response.provider === STORAGE_PROVIDERS.APPLE_NOTES) {
      connText.textContent = response.configured ? 'Apple 備忘錄已連線' : '備忘錄資料夾不存在';
    } else {
      connText.textContent = response.ok ? 'Obsidian 已連線' : 'Obsidian 未連線';
    }
  } catch (error) {
    if (!isCurrentRequest()) return;
    connDot.className = 'dot fail';
    connText.textContent = error.message || '儲存目的地無法連線';
  }
}

async function renderQueueInfo() {
  const { offlineQueue = [] } = await chrome.storage.local.get('offlineQueue');
  queueInfo.hidden = offlineQueue.length === 0;
  if (!offlineQueue.length) return;
  const labels = [...new Set(offlineQueue.map(item => providerLabel(item.provider || item.ref?.provider)))];
  queueInfo.textContent = `待補存 ${offlineQueue.length} 則（原目的地：${labels.join('、')}，恢復後自動補存）`;
}

function formatTime(iso) {
  const time = new Date(iso);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(time.getMonth() + 1)}/${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

function fallbackPreview(filename) {
  return String(filename || '')
    .replace(/^\d{4}-\d{2}-\d{2}_\d{4}_/, '')
    .replace(/^_草稿_/, '')
    .replace(/\.md$/i, '')
    .replace(/_/g, ' ')
    .trim() || '目前沒有可顯示的文字內容';
}

function showPreview(anchor, text) {
  activePreviewAnchor?.removeAttribute('aria-describedby');
  activePreviewAnchor = anchor;
  previewText.textContent = text;
  previewPopover.hidden = false;
  anchor.setAttribute('aria-describedby', 'previewPopover');
  const itemRect = anchor.closest('li').getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  previewPopover.style.width = `${width}px`;
  previewPopover.style.left = `${Math.max(12, Math.min(itemRect.left, window.innerWidth - width - 12))}px`;
  const below = itemRect.bottom + 7;
  previewPopover.style.top = `${below + previewPopover.offsetHeight <= window.innerHeight - 12
    ? below
    : Math.max(12, itemRect.top - previewPopover.offsetHeight - 7)}px`;
}

function hidePreview(anchor) {
  previewPopover.hidden = true;
  const target = anchor || activePreviewAnchor;
  target?.removeAttribute('aria-describedby');
  if (!anchor || anchor === activePreviewAnchor) activePreviewAnchor = null;
}

function buildListItem(filename, ref, metaText, preview, kind, key = '') {
  const li = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'activity-open-link';
  link.href = '#';
  link.setAttribute('aria-label', `開啟 ${filename}`);
  const copy = document.createElement('span');
  copy.className = 'activity-copy';
  const name = document.createElement('span');
  name.className = 'activity-filename';
  name.textContent = filename;
  const meta = document.createElement('small');
  meta.textContent = metaText;
  const openIcon = document.createElement('span');
  openIcon.className = 'activity-open-icon';
  openIcon.setAttribute('aria-hidden', 'true');
  openIcon.textContent = ref ? '↗' : '•';
  copy.append(name, meta);
  link.append(copy, openIcon);
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!ref) return;
    const response = await chrome.runtime.sendMessage({ type: 'OPEN_STORAGE_ACTIVITY', ref });
    if (!response?.ok) showActionStatus(response?.error || '無法開啟項目', 'error');
  });
  const previewContent = preview || fallbackPreview(filename);
  li.addEventListener('mouseenter', () => showPreview(link, previewContent));
  li.addEventListener('mouseleave', () => hidePreview(link));
  link.addEventListener('focus', () => showPreview(link, previewContent));
  link.addEventListener('blur', () => hidePreview(link));
  li.appendChild(link);
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'activity-delete-btn';
  deleteButton.textContent = '刪';
  deleteButton.setAttribute('aria-label', `刪除 ${filename}`);
  deleteButton.addEventListener('click', () => deleteActivityItem(deleteButton, kind, filename, ref, key));
  li.appendChild(deleteButton);
  return li;
}

function buildEmptyState(message) {
  const li = document.createElement('li');
  li.className = 'empty-state';
  li.textContent = message;
  return li;
}

async function deleteActivityItem(button, kind, filename, ref, key) {
  if (kind === 'recent' && !window.confirm(`確定要從儲存目的地刪除「${filename}」？\n\n社群平台上的原貼文不會被刪除。`)) return;
  button.disabled = true;
  hidePreview();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_VAULT_ACTIVITY', kind, ref, key });
    if (!response?.ok) throw new Error(response?.error || '貼文刪除失敗');
    showActionStatus(`已刪除 · ${filename}`, 'success');
    await Promise.all([renderDrafts(), renderRecent()]);
  } catch (error) {
    showActionStatus(`貼文刪除失敗 · ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function renderDrafts() {
  const stored = await chrome.storage.local.get(['draftStatus_x', 'draftStatus_threads']);
  const drafts = [
    ['draftStatus_x', platformDisplayName('x'), stored.draftStatus_x],
    ['draftStatus_threads', platformDisplayName('threads'), stored.draftStatus_threads]
  ].filter(([, , draft]) => draft);
  draftSection.hidden = drafts.length === 0;
  draftList.textContent = '';
  for (const [key, platform, draft] of drafts) {
    draftList.appendChild(buildListItem(
      draft.filename,
      draft.ref,
      `${platform} · 最後暫存 ${formatTime(draft.savedAt)}`,
      draft.preview,
      'draft',
      key
    ));
  }
}

async function clearAutoDrafts() {
  clearDraftsBtn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_AUTO_DRAFTS' });
    if (!response?.ok) throw new Error(response?.error || '草稿清除失敗');
    showActionStatus(response.cleared ? `已清除 ${response.cleared} 則自動暫存` : '目前沒有自動暫存', 'success');
    await renderDrafts();
  } catch (error) {
    showActionStatus(`草稿清除失敗 · ${error.message}`, 'error');
  } finally {
    clearDraftsBtn.disabled = false;
  }
}

async function syncStorageActivity() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'SYNC_VAULT_ACTIVITY',
      skipAppleNotes: true
    });
    if (!response?.ok) throw new Error(response?.error || '背景程序沒有回應');
    const removed = (response.removedDrafts || 0) + (response.removedRecent || 0);
    if (removed) showActionStatus(`已同步刪除狀態 · ${removed} 則`, 'success');
  } catch (error) {
    showActionStatus(`狀態同步失敗 · ${error.message}`, 'error');
  }
}

async function renderRecent() {
  const { recentSaves = [] } = await chrome.storage.local.get('recentSaves');
  const activeProvider = resolveStorageProvider(loadedSettings);
  const visibleRecentSaves = recentSaves.filter(item => item.ref?.provider === activeProvider);
  recentList.textContent = '';
  if (!visibleRecentSaves.length) {
    recentList.appendChild(buildEmptyState('目前儲存目的地尚無最近存檔'));
    return;
  }
  for (const item of visibleRecentSaves) {
    recentList.appendChild(buildListItem(
      item.filename,
      item.ref,
      `${(item.platforms || [item.platform]).map(platformDisplayName).join(' ＋ ')} · ${providerLabel(item.ref?.provider)} · ${formatTime(item.savedAt)}`,
      item.preview,
      'recent'
    ));
  }
}

function renderDuplicateResults(response) {
  duplicateResults.textContent = '';
  const providerResults = Array.isArray(response.providers) ? response.providers : [];
  for (const provider of providerResults) {
    const status = document.createElement('p');
    status.className = provider.ok ? 'duplicate-provider-status' : 'duplicate-provider-status error';
    status.textContent = provider.ok
      ? `${providerLabel(provider.provider)} · 找到 ${provider.groups || 0} 組`
      : `${providerLabel(provider.provider)} · ${provider.error || '掃描失敗'}`;
    duplicateResults.appendChild(status);
  }
  for (const group of response.groups || []) {
    const label = document.createElement('label');
    label.className = `duplicate-group${group.blocked ? ' blocked' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = group.id;
    checkbox.checked = !group.blocked;
    checkbox.disabled = !!group.blocked;
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = group.canonical?.title || '未命名貼文';
    const detail = document.createElement('small');
    detail.textContent = group.blocked
      ? group.blockedReason || '需人工處理'
      : `${(group.platforms || []).map(platformDisplayName).join(' ＋ ')} · 保留最早筆記，合併 ${group.duplicates?.length || 0} 篇`;
    copy.append(title, detail);
    label.append(checkbox, copy);
    duplicateResults.appendChild(label);
  }
  duplicateScanId = response.scanId || '';
  duplicateResults.hidden = false;
  duplicateMergeBtn.hidden = !(response.groups || []).some(group => !group.blocked);
}

async function scanDuplicatePosts() {
  duplicateScanBtn.disabled = true;
  duplicateMergeBtn.hidden = true;
  duplicateResults.hidden = true;
  duplicateStatus.textContent = '正在掃描已設定的目的地…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SCAN_DUPLICATE_POSTS' });
    if (!response?.ok) throw new Error(response?.error || '掃描失敗');
    renderDuplicateResults(response);
    duplicateStatus.textContent = response.groups?.length
      ? `找到 ${response.groups.length} 組跨平台重複文章`
      : '沒有找到可安全合併的跨平台重複文章';
  } catch (error) {
    duplicateStatus.textContent = `掃描失敗 · ${error.message}`;
  } finally {
    duplicateScanBtn.disabled = false;
  }
}

async function mergeDuplicatePosts() {
  const groupIds = [...duplicateResults.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value);
  if (!groupIds.length) return;
  if (!window.confirm(`確定要合併 ${groupIds.length} 組重複文章？\n\n系統會先更新並讀回最早筆記，驗證成功後才刪除其餘重複筆記。`)) return;
  duplicateMergeBtn.disabled = true;
  duplicateScanBtn.disabled = true;
  duplicateStatus.textContent = '正在重新驗證並合併…';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'MERGE_DUPLICATE_POSTS',
      scanId: duplicateScanId,
      groupIds
    });
    if (!response?.ok) throw new Error(response?.error || '合併失敗');
    duplicateStatus.textContent = `已合併 ${response.merged || 0} 組；略過 ${response.skipped || 0} 組`;
    await scanDuplicatePosts();
    await renderRecent();
  } catch (error) {
    duplicateStatus.textContent = `合併失敗 · ${error.message}`;
  } finally {
    duplicateMergeBtn.disabled = false;
    duplicateScanBtn.disabled = false;
  }
}

async function restoreDuplicateScan() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_DUPLICATE_SCAN_SESSION' });
    if (!response?.ok || !response.scanId) return;
    renderDuplicateResults(response);
    duplicateStatus.textContent = response.groups?.length
      ? `上次掃描找到 ${response.groups.length} 組；合併前仍會重新驗證`
      : '上次掃描沒有找到可安全合併的文章';
  } catch {
    // 掃描結果只是維護工具，不影響主要存檔功能。
  }
}

function toggleApiKeyVisibility() {
  const visible = apiKeyInput.type === 'text';
  apiKeyInput.type = visible ? 'password' : 'text';
  toggleApiKey.textContent = visible ? '顯示' : '隱藏';
  toggleApiKey.setAttribute('aria-pressed', String(!visible));
  apiKeyInput.focus();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const draftsChanged = changes.draftStatus_x || changes.draftStatus_threads;
  if (draftsChanged || changes.recentSaves) hidePreview();
  if (draftsChanged) renderDrafts();
  if (changes.recentSaves && !changes.storageProvider) renderRecent();
  if (changes.offlineQueue) renderQueueInfo();
  if (changes.storageProvider || changes.markdownFolderSettings || changes.appleNotesSettings || changes.obsidianRestSettings) {
    for (const key of ['storageProvider', 'markdownFolderSettings', 'appleNotesSettings', 'obsidianRestSettings']) {
      if (changes[key]) loadedSettings[key] = changes[key].newValue;
    }
    if (changes.storageProvider) {
      hidePreview();
      void renderRecent();
    }
    if (resolveStorageProvider(loadedSettings) === STORAGE_PROVIDERS.APPLE_NOTES) {
      renderStoredConnectionStatus();
    } else {
      void checkConnection();
    }
  }
});

settingsForm.addEventListener('submit', (event) => { event.preventDefault(); saveSettings(); });
testBtn.addEventListener('click', testConnection);
toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
chooseFolderBtn.addEventListener('click', chooseFolder);
refreshNotesBtn.addEventListener('click', () => loadNotesLocations(selectedNotesLocation()));
clearDraftsBtn.addEventListener('click', clearAutoDrafts);
duplicateScanBtn.addEventListener('click', scanDuplicatePosts);
duplicateMergeBtn.addEventListener('click', mergeDuplicatePosts);
storageProviderSelect.addEventListener('change', () => {
  connectionRequestId++;
  clearProviderStatus();
  connDot.className = 'dot';
  connText.textContent = `切換至 ${providerLabel(storageProviderSelect.value)} · 儲存後生效`;
  updateModeUI(true);
  if (
    storageProviderSelect.value === STORAGE_PROVIDERS.APPLE_NOTES
    && ![...notesLocationSelect.options].some(option => option.value)
  ) {
    void loadNotesLocations(loadedSettings.appleNotesSettings);
  }
});
portInput.addEventListener('input', updateHttpWarning);
document.addEventListener('scroll', () => hidePreview(), true);

async function initialize() {
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
  await loadSettings();
  renderStoredConnectionStatus();
  await Promise.all([renderQueueInfo(), renderDrafts(), renderRecent()]);
  void restoreDuplicateScan();
  void syncStorageActivity();
  if (resolveStorageProvider(loadedSettings) !== STORAGE_PROVIDERS.APPLE_NOTES) {
    void checkConnection();
  }
}

initialize();
