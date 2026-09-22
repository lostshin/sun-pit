import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

// Keep local-time filename assertions deterministic across developer machines and CI.
process.env.TZ = 'Asia/Taipei';
const manifestVersion = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
const popupHtml = readFileSync('popup/popup.html', 'utf8');
const popupCss = readFileSync('popup/popup.css', 'utf8');
const popupScript = readFileSync('popup/popup.js', 'utf8');
for (const provider of ['markdown-folder', 'obsidian-rest', 'apple-notes']) {
  assert.match(popupHtml, new RegExp(`value="${provider}"`), `popup 必須提供 ${provider} 設定面板`);
}
assert.match(popupScript, /OPEN_STORAGE_ACTIVITY/, '最近項目開啟必須交給 background provider');
assert.match(popupScript, /DELETE_VAULT_ACTIVITY/, '跨 provider 刪除必須交給 background provider');
assert.match(
  popupScript,
  /NATIVE_HOST_UPDATE_REQUIRED/,
  'Popup 必須把舊版 Helper 顯示為需要更新，而不是直接顯示底層 action 錯誤'
);
assert.match(popupHtml, /class="input-with-action notes-location-control"/);
assert.match(popupCss, /appearance:\s*none/, 'Select 必須使用可控制安全邊距的自訂箭頭');
assert.match(popupCss, /\.notes-location-control\s*\{[\s\S]*?display:\s*grid/);
assert.doesNotMatch(popupCss, /cursor:\s*wait/, '背景檢查不得讓滑鼠指標反覆切換等待狀態');
const loadSettingsSource = popupScript.match(
  /async function loadSettings\(\)[\s\S]*?\n}\n\nfunction selectedNotesLocation/
)?.[0] || '';
assert.doesNotMatch(
  loadSettingsSource,
  /GET_STORAGE_STATUS/,
  'Popup 初始讀設定不得同步等待遠端連線檢查'
);
assert.doesNotMatch(
  loadSettingsSource,
  /await loadNotesLocations/,
  'Popup 初始版面不得等待 AppleScript 列舉 Notes locations'
);
assert.match(popupScript, /appleNotesLocationsCache/, 'Notes locations 必須優先使用本機快取');
assert.match(popupScript, /skipAppleNotes:\s*true/, 'Popup 自動同步不得逐筆查詢 Apple 備忘錄');
assert.match(
  popupScript,
  /function clearProviderStatus\(\)/,
  '切換儲存目的地時必須清除前一個 provider 留下的錯誤狀態'
);
assert.match(
  popupScript,
  /connectionRequestId/,
  '較慢完成的舊 provider 連線檢查不得覆寫目前目的地狀態'
);
assert.match(
  popupScript,
  /儲存後生效/,
  '目的地尚未儲存時，連線卡片必須明確顯示尚未生效'
);
assert.match(
  popupScript,
  /原目的地：/,
  '離線 queue 必須明確標示原目的地，避免被誤認為目前目的地錯誤'
);
const providerChangeSource = popupScript.match(
  /storageProviderSelect\.addEventListener\('change',[\s\S]*?\n}\);/
)?.[0] || '';
assert.match(providerChangeSource, /clearProviderStatus\(\)/);
assert.match(providerChangeSource, /connectionRequestId\+\+/);
const connectionCheckSource = popupScript.match(
  /async function checkConnection\(\)[\s\S]*?\n}\n\nasync function renderQueueInfo/
)?.[0] || '';
assert.match(connectionCheckSource, /if \(!isCurrentRequest\(\)/);
const renderRecentSource = popupScript.match(
  /async function renderRecent\(\)[\s\S]*?\n}\n\nfunction toggleApiKeyVisibility/
)?.[0] || '';
assert.match(
  renderRecentSource,
  /item\.ref\?\.provider === activeProvider/,
  '最近儲存只可顯示目前已生效 provider 的紀錄'
);
assert.match(
  popupScript,
  /if \(changes\.storageProvider\)[\s\S]*?renderRecent\(\)/,
  '切換已生效目的地時必須重新繪製最近儲存'
);
assert.doesNotMatch(
  popupScript,
  /window\.addEventListener\('focus',[\s\S]*?syncStorageActivity/,
  'Popup 開啟時不得因 focus 再做一次重複同步'
);
assert.match(popupHtml, /id="duplicateScanBtn"/, 'Popup 必須提供手動重複文章掃描入口');
assert.match(popupScript, /SCAN_DUPLICATE_POSTS/, '重複文章掃描必須交給 background');
assert.match(popupScript, /MERGE_DUPLICATE_POSTS/, '確認後的合併必須交給 background');
assert.match(popupScript, /GET_DUPLICATE_SCAN_SESSION/, 'Popup 重開後必須能恢復尚未確認的掃描預覽');

// 新使用者從 Web Store 安裝後，直接執行 Helper installer 也必須被授權；
// 不能要求使用者先知道並手動傳入正式 extension ID。
const installerTestHome = mkdtempSync(join(tmpdir(), 'sp2o-installer-test-'));
try {
  const installerSource = readFileSync('native/install-host.sh', 'utf8');
  const testInstallerSource = installerSource.replace(
    'if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then',
    'if false; then'
  );
  assert.notEqual(testInstallerSource, installerSource, '測試必須只略過 macOS 平台閘門');
  const installerTestNativeDirectory = join(installerTestHome, 'native');
  mkdirSync(installerTestNativeDirectory);
  const installerTestPath = join(installerTestNativeDirectory, 'install-host.sh');
  writeFileSync(installerTestPath, testInstallerSource, { mode: 0o755 });
  copyFileSync('native/host.rb', join(installerTestNativeDirectory, 'host.rb'));
  const installerConfigDirectory = join(
    installerTestHome,
    'Library/Application Support/sun-pit'
  );
  mkdirSync(installerConfigDirectory, { recursive: true });
  writeFileSync(
    join(installerConfigDirectory, 'config.json'),
    JSON.stringify({ vaultPath: '/tmp/legacy-vault' })
  );
  const installResult = spawnSync('/bin/zsh', [installerTestPath], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: installerTestHome },
    encoding: 'utf8'
  });
  assert.equal(installResult.status, 0, installResult.stderr);
  const installedManifest = JSON.parse(readFileSync(join(
    installerTestHome,
    'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.lostshin.sun_pit.json'
  ), 'utf8'));
  assert.ok(
    installedManifest.allowed_origins.includes('chrome-extension://jdfempgjnmdlokacfjmnpiphhghcnomb/'),
    'installer 預設必須授權 Chrome Web Store 正式版'
  );
  assert.equal(installedManifest.allowed_origins.length, 2, 'installer 仍須同時授權目前未封裝版');
  assert.deepEqual(
    JSON.parse(readFileSync(join(installerConfigDirectory, 'config.json'), 'utf8')),
    { folderPath: '/tmp/legacy-vault' },
    'Helper installer 要一次性把 vaultPath 轉成通用 folderPath'
  );
} finally {
  rmSync(installerTestHome, { recursive: true, force: true });
}

function loadCommon() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    window: {
      addEventListener() {},
      postMessage() {}
    },
    document: {},
    chrome: {
      runtime: {
        id: 'test',
        getManifest: () => ({ version: manifestVersion }),
        onMessage: { addListener() {} }
      }
    }
  });
  vm.runInContext(readFileSync('content/common.js', 'utf8'), context);
  return context.SP2O;
}

const common = loadCommon();

function loadInterceptor(responseText, options = {}) {
  const messages = [];
  const requests = [];
  const listeners = {};
  class XMLHttpRequestStub {
    open() {}
    setRequestHeader() {}
    send() {}
    addEventListener() {}
  }
  const window = {
    location: { origin: options.origin || 'https://www.threads.com' },
    postMessage(message) { messages.push(message); },
    addEventListener(type, listener) { listeners[type] = listener; },
    // 主動掃描重播請求時會直接呼叫 origFetch，回傳的是 Response 而非 clone 來源
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const replay = options.replay ? options.replay(String(url), requests.length) : responseText;
      const body = replay && typeof replay === 'object' ? replay.body : replay;
      const status = replay && typeof replay === 'object' ? replay.status : 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        clone: () => ({ text: async () => body })
      };
    }
  };
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    setTimeout: (callback) => { callback(); return 0; },
    XMLHttpRequest: XMLHttpRequestStub,
    window
  });
  vm.runInContext(readFileSync('content/interceptor.js', 'utf8'), context);
  return {
    fetch: context.window.fetch,
    messages,
    requests,
    // 模擬 content script（或頁面腳本）送進 MAIN world 的訊息
    send(data) { listeners.message({ source: window, data }); }
  };
}

const threadsPublishInterceptor = loadInterceptor('{"status":"ok"}');
for (const endpoint of [
  '/api/v1/media/configure_text_only_post/',
  '/api/v1/media/configure_text_post_app_feed/',
  '/api/v1/media/configure_text_post_app_sidecar/'
]) {
  await threadsPublishInterceptor.fetch(endpoint, { method: 'POST' });
}
await threadsPublishInterceptor.fetch('/api/v1/media/upload_photo/', { method: 'POST' });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(
  threadsPublishInterceptor.messages.map(message => message.platform),
  ['threads', 'threads', 'threads']
);
assert.deepEqual(
  threadsPublishInterceptor.messages.map(message => message.requestUrl),
  [
    '/api/v1/media/configure_text_only_post/',
    '/api/v1/media/configure_text_post_app_feed/',
    '/api/v1/media/configure_text_post_app_sidecar/'
  ]
);

let lastBackfillConfig = null;

function loadTwitterExtractor(nodes, options = {}) {
  let pipelineConfig = null;
  let backfillConfig = null;
  const dialog = {
    querySelector: () => null,
    querySelectorAll(selector) {
      return nodes.filter(node => (
        !selector.includes('[contenteditable="true"]')
        || node.getAttribute('contenteditable') === 'true'
      ));
    }
  };
  const context = vm.createContext({
    console,
    window: { location: { href: options.href || 'https://x.com/compose/post' } },
    document: {
      querySelector: selector => {
        if (selector === '[role="dialog"]') return dialog;
        // 側邊欄的個人頁連結：補存判斷「哪些貼文是我寫的」靠這個
        if (selector === 'a[data-testid="AppTabBar_Profile_Link"]') {
          return { getAttribute: () => '/me' };
        }
        return null;
      },
      querySelectorAll: () => [],
      addEventListener() {}
    },
    SP2O: {
      parseCreateTweet() {},
      parseUserTweets() {},
      createPublishPipeline(config) {
        pipelineConfig = config;
        return { capturePost() {}, init() {} };
      },
      createBackfillWatcher(config) {
        backfillConfig = config;
        lastBackfillConfig = config;
      }
    }
  });
  vm.runInContext(readFileSync('content/twitter.js', 'utf8'), context);
  return pipelineConfig;
}

function createTwitterTextarea(testId, text, contenteditable = null) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === 'data-testid') return testId;
      if (name === 'contenteditable') return contenteditable;
      return null;
    },
    querySelector() { return null; }
  };
}

// X 的 label、RichTextInputContainer 與真正編輯器會共用 tweetTextarea_ 前綴，
// 只有 contenteditable 節點是使用者輸入，否則單則草稿會被擷取三次。
const twitterSingleDraft = loadTwitterExtractor([
  createTwitterTextarea('tweetTextarea_0_label', '同一段草稿'),
  createTwitterTextarea('tweetTextarea_0RichTextInputContainer', '同一段草稿'),
  createTwitterTextarea('tweetTextarea_0', '同一段草稿', 'true')
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(twitterSingleDraft.getTextContent())),
  ['同一段草稿']
);

// 真正的兩個串文編輯器即使文字相同，仍須保留為兩則，不能按文字去重。
const twitterIdenticalThread = loadTwitterExtractor([
  createTwitterTextarea('tweetTextarea_0', '相同內容', 'true'),
  createTwitterTextarea('tweetTextarea_1', '相同內容', 'true')
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(twitterIdenticalThread.getTextContent())),
  ['相同內容', '相同內容']
);

function loadThreadsExtractor(nodes, options = {}) {
  let pipelineConfig = null;
  let capturePostCount = 0;
  const listeners = {};
  const dialog = {
    querySelectorAll: () => nodes,
    // dialog 內顯示的母貼文連結：Threads 用 dialog 回覆時唯一的 replyTo 來源
    querySelector: () => (options.dialogPostLink
      ? { getAttribute: () => options.dialogPostLink }
      : null)
  };
  const context = vm.createContext({
    console,
    window: { location: { href: options.href || 'https://www.threads.com/' } },
    document: {
      querySelector: selector => selector === '[role="dialog"]' ? dialog : null,
      querySelectorAll: () => [],
      addEventListener(type, listener) { listeners[type] = listener; }
    },
    SP2O: {
      parseThreadsCreate() {},
      createPublishPipeline(config) {
        pipelineConfig = config;
        return {
          capturePost() { capturePostCount++; },
          init(setupListener) { setupListener(); }
        };
      }
    }
  });
  vm.runInContext(readFileSync('content/threads.js', 'utf8'), context);
  pipelineConfig.submit = (text, ariaLabel = '') => {
    const button = {
      textContent: text,
      getAttribute(name) { return name === 'aria-label' ? ariaLabel : null; },
      closest(selector) { return selector === '[role="dialog"]' ? dialog : null; }
    };
    listeners.click({ target: { closest: () => button } });
  };
  pipelineConfig.capturePostCount = () => capturePostCount;
  // 讓測試能組出「composer 在 dialog 內」的 source
  pipelineConfig.dialogSource = { closest: (selector) => (selector === '[role="dialog"]' ? dialog : null) };
  return pipelineConfig;
}

// Threads 點「回覆」開的是 dialog。舊版遇到 dialog 一律回 null，
// 加上 create response 也不給 replyTo，等於 Threads 的自回覆永遠不會合併。
const threadsReplyDialog = loadThreadsExtractor([], { dialogPostLink: '/@lokunlim/post/DAbc123' });
assert.equal(
  threadsReplyDialog.getReplyTo(threadsReplyDialog.dialogSource),
  'https://www.threads.com/@lokunlim/post/DAbc123'
);
// dialog 內沒有母貼文＝一般發文，不得拿頁面網址亂猜
const threadsPlainDialog = loadThreadsExtractor([], {
  href: 'https://www.threads.com/@lokunlim/post/DXyz'
});
assert.equal(threadsPlainDialog.getReplyTo(threadsPlainDialog.dialogSource), null);

const threadsThread = loadThreadsExtractor([
  createTwitterTextarea('threads_0', 'Threads 第一則', 'true'),
  createTwitterTextarea('threads_1', 'Threads 第二則', 'true')
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(threadsThread.getTextContent())),
  ['Threads 第一則', 'Threads 第二則']
);
threadsThread.submit('Reply');
threadsThread.submit('回覆');
threadsThread.submit('', 'Reply');
assert.equal(
  threadsThread.capturePostCount(),
  3,
  'Threads 的 Reply／回覆按鈕必須進入正式發佈流程'
);
threadsThread.submit('回覆選項');
assert.equal(
  threadsThread.capturePostCount(),
  3,
  '只應精確匹配送出按鈕，不得把回覆選項當成送出'
);

function loadInlineThreadsExtractor() {
  const listeners = {};
  const capturedSources = [];
  let pipelineConfig = null;

  const main = {
    parentElement: null,
    matches: selector => selector.includes('main')
  };
  const navigation = {
    parentElement: null,
    matches: selector => selector.includes('nav')
  };
  const composer = {
    parentElement: main,
    matches: () => false,
    querySelectorAll(selector) {
      if (selector.includes('contenteditable')) return [input];
      if (selector.includes('[role="button"]')) return [button];
      return [];
    },
    querySelector() { return null; }
  };
  const input = {
    innerText: 'Inline Threads 回覆',
    textContent: 'Inline Threads 回覆',
    parentElement: composer,
    closest(selector) {
      if (selector.includes('main')) return main;
      return null;
    },
    addEventListener() {}
  };
  const button = {
    textContent: '回覆',
    parentElement: composer,
    getAttribute(name) { return name === 'aria-label' ? '回覆' : null; },
    closest(selector) {
      if (selector.includes('main')) return main;
      return null;
    }
  };
  const searchContainer = {
    parentElement: navigation,
    matches: () => false,
    querySelectorAll(selector) {
      return selector.includes('contenteditable') ? [searchInput] : [];
    }
  };
  const searchInput = {
    innerText: '不應存檔的搜尋文字',
    textContent: '不應存檔的搜尋文字',
    parentElement: searchContainer,
    closest(selector) {
      if (selector.includes('nav')) return navigation;
      return null;
    },
    addEventListener() {}
  };

  const context = vm.createContext({
    console,
    window: { location: { href: 'https://www.threads.com/@me/post/THREADS_ROOT?x=1' } },
    document: {
      body: {},
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: selector => selector.includes('contenteditable') ? [input, searchInput] : [],
      addEventListener(type, listener) { listeners[type] = listener; }
    },
    SP2O: {
      parseThreadsCreate() {},
      createPublishPipeline(config) {
        pipelineConfig = config;
        return {
          capturePost(source) { capturedSources.push(source); },
          init(setupListener) { setupListener(); }
        };
      }
    }
  });
  vm.runInContext(readFileSync('content/threads.js', 'utf8'), context);

  return {
    config: pipelineConfig,
    input,
    button,
    searchInput,
    capturedSources,
    submit() {
      listeners.click({ target: { closest: () => button } });
    }
  };
}

// 貼文頁的回覆 composer 是 inline 區塊，不一定有 role="dialog"。
// v2.11.0 因硬性要求 dialog，草稿與送出事件都完全略過。
const inlineThreads = loadInlineThreadsExtractor();
const inlineDraftInputs = inlineThreads.config.getDraftInputs();
assert.equal(inlineDraftInputs.length, 1, 'inline Threads 回覆輸入框必須掛上草稿監聽');
assert.equal(inlineDraftInputs[0], inlineThreads.input);
assert.ok(!inlineDraftInputs.includes(inlineThreads.searchInput), '搜尋框不得被當成 Threads 草稿');
assert.deepEqual(
  JSON.parse(JSON.stringify(inlineThreads.config.getTextContent(inlineThreads.input))),
  ['Inline Threads 回覆']
);
assert.equal(
  inlineThreads.config.getReplyTo(inlineThreads.input),
  'https://www.threads.com/@me/post/THREADS_ROOT',
  'Threads inline 回覆必須把目前貼文 URL 傳入合併判斷'
);
inlineThreads.submit();
assert.equal(inlineThreads.capturedSources.length, 1, 'inline Threads 回覆按鈕必須進入正式發佈流程');
assert.equal(inlineThreads.capturedSources[0], inlineThreads.button);

function loadDraftPipelineHarness(contentItems, initialEvent = 'input') {
  const messages = [];
  const timers = [];
  const listenersByInput = new WeakMap();
  const contentSources = [];
  const draftInputSources = [];
  let mutationCallback = null;

  function createInput(text, editorId = 'tweetTextarea_0') {
    const listeners = {};
    const input = {
      innerText: text,
      textContent: text,
      getAttribute(name) {
        return name === 'data-testid' ? editorId : null;
      },
      addEventListener(type, listener) { listeners[type] = listener; }
    };
    listenersByInput.set(input, listeners);
    return input;
  }

  const input = createInput(contentItems[0] || '');
  const inputListeners = listenersByInput.get(input);
  let draftInputs = [input];
  const context = vm.createContext({
    console,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
    window: {
      location: { href: 'https://x.com/compose/post' },
      addEventListener() {},
      postMessage() {}
    },
    document: { readyState: 'complete', body: {} },
    chrome: {
      runtime: {
        id: 'test',
        lastError: null,
        getManifest: () => ({ version: manifestVersion }),
        sendMessage(message, callback) {
          messages.push(message);
          callback?.();
        },
        onMessage: { addListener() {} }
      }
    }
  });
  vm.runInContext(readFileSync('content/common.js', 'utf8'), context);
  const pipeline = context.SP2O.createPublishPipeline({
    platform: 'x',
    label: 'Twitter',
    parseResponse: () => null,
    getTextContent: (source) => {
      contentSources.push(source);
      return contentItems;
    },
    getDraftInputs: (source) => {
      draftInputSources.push(source);
      return draftInputs;
    }
  });
  pipeline.init(() => {});
  if (initialEvent) inputListeners[initialEvent]();
  return {
    inputListeners,
    messages,
    pipeline,
    timers,
    contentSources,
    draftInputSources,
    replaceInput(text, editorId = 'tweetTextarea_0') {
      const replacement = createInput(text, editorId);
      draftInputs = [replacement];
      mutationCallback();
      timers.at(-1).callback();
      return {
        input: replacement,
        listeners: listenersByInput.get(replacement)
      };
    }
  };
}

const draftPipeline = loadDraftPipelineHarness(['串文第一則', '串文第二則']);
assert.equal(
  draftPipeline.messages[0].type,
  'CANCEL_X_BACKFILL_SCAN',
  '開始輸入時應停止同分頁啟動的背景補存掃描'
);
assert.equal(draftPipeline.timers.at(-1).delay, 500);
draftPipeline.timers.at(-1).callback();
assert.equal(draftPipeline.messages.at(-1).data.content, '串文第一則\n\n---\n\n串文第二則');
assert.deepEqual(
  JSON.parse(JSON.stringify(draftPipeline.messages.at(-1).data.thread)),
  ['串文第一則', '串文第二則']
);
const draftSessionId = draftPipeline.messages.at(-1).data.draftSessionId;
assert.ok(draftSessionId, '草稿必須帶 composer session ID');
const messagesBeforePublish = draftPipeline.messages.length;
draftPipeline.pipeline.capturePost();
assert.equal(
  draftPipeline.messages.length,
  messagesBeforePublish + 1,
  '發佈前必須立即保存按下按鈕當下的完整草稿'
);
assert.equal(draftPipeline.messages.at(-1).type, 'SAVE_DRAFT');
assert.equal(draftPipeline.messages.at(-1).data.content, '串文第一則\n\n---\n\n串文第二則');
assert.equal(draftPipeline.messages.at(-1).data.draftSessionId, draftSessionId);
assert.equal(draftPipeline.timers.at(-1).delay, 8000);
draftPipeline.timers.at(-1).callback();
assert.equal(draftPipeline.messages.at(-1).type, 'PUBLISH_DRAFT');
assert.equal(draftPipeline.messages.at(-1).data.draftSessionId, draftSessionId);
assert.deepEqual(
  JSON.parse(JSON.stringify(draftPipeline.messages.at(-1).data.thread)),
  ['串文第一則', '串文第二則']
);
const rerenderedComposer = draftPipeline.replaceInput('串文第一則');
const timersBeforeRerenderInput = draftPipeline.timers.length;
rerenderedComposer.listeners.input();
assert.equal(
  draftPipeline.timers.length,
  timersBeforeRerenderInput,
  '發佈後 X 重建 editor 的 DOM 收尾事件不得另開 session 並排入草稿'
);
rerenderedComposer.input.innerText = '';
rerenderedComposer.input.textContent = '';
rerenderedComposer.listeners.input();
rerenderedComposer.input.innerText = '下一篇貼文';
rerenderedComposer.input.textContent = '下一篇貼文';
rerenderedComposer.listeners.input();
assert.equal(
  draftPipeline.timers.length,
  timersBeforeRerenderInput + 1,
  'composer 清空後的下一篇貼文仍須建立新 session'
);

// X 的 Ctrl/Cmd+V 不一定會再派發 input；paste 本身也必須排入草稿 debounce。
const pastePipeline = loadDraftPipelineHarness(['直接貼上的完整內容'], 'paste');
assert.equal(pastePipeline.messages[0].type, 'CANCEL_X_BACKFILL_SCAN');
assert.equal(pastePipeline.timers.at(-1).delay, 500);
pastePipeline.timers.at(-1).callback();
assert.equal(pastePipeline.messages.at(-1).type, 'SAVE_DRAFT');
assert.equal(pastePipeline.messages.at(-1).data.content, '直接貼上的完整內容');
assert.ok(pastePipeline.messages.at(-1).data.draftSessionId);

const sourceAwarePipeline = loadDraftPipelineHarness(['來源限定的內容'], null);
const composerSource = { kind: 'inline-composer-button' };
sourceAwarePipeline.pipeline.capturePost(composerSource);
assert.equal(
  sourceAwarePipeline.contentSources.at(-1),
  composerSource,
  '共用 pipeline 必須把送出事件來源傳給平台內容擷取器'
);
assert.equal(
  sourceAwarePipeline.draftInputSources.at(-1),
  composerSource,
  '共用 pipeline 必須把送出事件來源傳給平台草稿輸入框擷取器'
);

// 未對應使用者送出動作的 API 回應不得寫檔，也不再顯示即時漏存提醒
function loadRecoveryHarness(platform = 'x') {
  const messages = [];
  const timers = [];
  const attached = new Map();
  let runtimeListener = null;

  function createElementStub(tagName) {
    const element = {
      tagName,
      id: '',
      type: '',
      textContent: '',
      offsetWidth: 0,
      style: { cssText: '', opacity: '' },
      children: [],
      listeners: {},
      setAttribute() {},
      addEventListener(type, listener) {
        (element.listeners[type] ||= []).push(listener);
      },
      append(...nodes) { element.children.push(...nodes); },
      remove() { attached.delete(element.id); }
    };
    return element;
  }

  const windowStub = {
    location: { href: 'https://x.com/home' },
    listeners: {},
    addEventListener(type, listener) { windowStub.listeners[type] = listener; },
    postMessage() {}
  };

  const context = vm.createContext({
    console,
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
    MutationObserver: class { observe() {} },
    window: windowStub,
    location: { href: 'https://x.com/home', origin: 'https://x.com', pathname: '/home' },
    document: {
      readyState: 'complete',
      body: {},
      createElement: createElementStub,
      getElementById: (id) => attached.get(id) || null,
      documentElement: {
        appendChild(element) { attached.set(element.id, element); return element; }
      }
    },
    chrome: {
      runtime: {
        id: 'test',
        lastError: null,
        getManifest: () => ({ version: manifestVersion }),
        sendMessage(message, callback) {
          messages.push(message);
          if (message.type === 'ENSURE_X_BACKFILL_SCAN') {
            callback?.({ ok: true, scanTab: false, opened: false });
          } else {
            callback?.({ ok: true });
          }
        },
        onMessage: {
          addListener(listener) { runtimeListener = listener; }
        }
      }
    }
  });
  vm.runInContext(readFileSync('content/common.js', 'utf8'), context);
  const pipeline = context.SP2O.createPublishPipeline({
    platform,
    label: platform === 'threads' ? 'Threads' : 'Twitter',
    parseResponse: (responseText) => JSON.parse(responseText),
    getTextContent: () => ['composer 內容'],
    getDraftInputs: () => []
  });
  pipeline.init(() => {});

  return {
    messages,
    pipeline,
    prompt: () => attached.get('sp2o-recover') || null,
    runtimeMessage(message) {
      runtimeListener?.(message, {}, () => {});
    },
    startBackfillWatcher() {
      context.SP2O.createBackfillWatcher({
        platform: 'x',
        label: 'Twitter',
        parseTimeline: () => [],
        getOwnAuthor: () => 'me',
        scanOperations: []
      });
    },
    intercept(api) {
      windowStub.listeners.message({
        source: windowStub,
        data: {
          source: 'sp2o-interceptor',
          platform,
          responseText: JSON.stringify(api)
        }
      });
    },
    toast: () => attached.get('sp2o-toast')?.textContent || null
  };
}

const recovery = loadRecoveryHarness();
recovery.intercept({ url: 'https://x.com/u/status/1', text: '漏存的貼文' });
assert.equal(recovery.messages.length, 0, '未對應發佈的回應不得自動建檔');
assert.equal(recovery.prompt(), null, '未對應發佈的回應不得顯示即時漏存提醒');

const quietThreads = loadRecoveryHarness('threads');
quietThreads.intercept({
  url: 'https://www.threads.com/@u/post/1',
  text: '未對應送出動作的 Threads 回應'
});
assert.equal(quietThreads.messages.length, 0, 'Threads 未對應發佈的回應不得自動建檔');
assert.equal(quietThreads.prompt(), null, 'Threads 不得再顯示即時漏存提醒');

// 正常發佈成功後，同串文的後續回應既不建檔也不跳補救提示
const recoveryQuiet = loadRecoveryHarness();
recoveryQuiet.pipeline.capturePost();
recoveryQuiet.intercept({ url: 'https://x.com/u/status/1', text: '第一則' });
assert.equal(recoveryQuiet.messages.at(-1).type, 'PUBLISH_DRAFT');
recoveryQuiet.intercept({ url: 'https://x.com/u/status/2', text: '第二則' });
assert.equal(
  recoveryQuiet.messages.filter(message => message.type === 'PUBLISH_DRAFT').length,
  1,
  '串文後續回應不得再建一個檔'
);
assert.equal(recoveryQuiet.prompt(), null, '串文後續回應不得跳補救提示');

// 一般 x.com 分頁要能接收背景暫存分頁找到的候選，並直接寫入——不再要求人工確認。
const relayedRecovery = loadRecoveryHarness();
relayedRecovery.startBackfillWatcher();
relayedRecovery.runtimeMessage({
  type: 'X_BACKFILL_RESULTS',
  posts: [{
    content: '背景掃描找到的回覆',
    platform: 'x',
    url: 'https://x.com/me/status/7001',
    timestamp: '2026-07-23T07:40:00.000Z',
    replyTo: 'https://x.com/someone/status/7000'
  }]
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(relayedRecovery.prompt(), null, '補存不得再顯示需人工確認的提示');
const relayedSave = relayedRecovery.messages.find(message => message.type === 'SAVE_POST');
assert.ok(relayedSave, '背景掃描結果應直接補存，不等待人工點擊');
assert.equal(relayedSave.data.url, 'https://x.com/me/status/7001');
assert.equal(relayedSave.silent, true, '補存要抑制逐則 toast，改由分頁端統一回報');
assert.equal(relayedRecovery.toast(), '✓ 已補存 1 則貼文', '補存完成要跳一次總結 toast');

function parseYamlFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  assert.ok(match, 'Markdown must start with YAML frontmatter');
  const result = spawnSync('/usr/bin/ruby', [
    '-ryaml', '-rjson', '-e',
    'puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false))'
  ], { input: match[1] });
  assert.equal(result.status, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

function sendNativeHostMessage(message, configDirectory, extraEnv = {}) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  const result = spawnSync('/usr/bin/ruby', ['native/host.rb'], {
    input: Buffer.concat([header, payload]),
    env: { ...process.env, SP2O_CONFIG_DIR: configDirectory, ...extraEnv }
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(result.stdout.length >= 4, 'Native host did not return a framed response');
  const responseLength = result.stdout.readUInt32LE(0);
  return JSON.parse(result.stdout.subarray(4, 4 + responseLength).toString());
}

const nativeTestRoot = mkdtempSync(join(tmpdir(), 'sp2o-native-test-'));
try {
  const vaultPath = join(nativeTestRoot, 'Test Vault');
  const configDirectory = join(nativeTestRoot, 'config');
  const mediaRoot = join(vaultPath, '附件', '順筆');
  mkdirSync(vaultPath, { recursive: true });

  assert.deepEqual(sendNativeHostMessage({ action: 'ping' }, configDirectory), {
    ok: true,
    configured: false,
    version: '1.10.0'
  });

  // framing 錯誤：host 需回傳 framed 錯誤訊息後結束，而不是直接崩潰
  {
    const result = spawnSync('/usr/bin/ruby', ['native/host.rb'], {
      input: Buffer.from([0x01, 0x02]),
      env: { ...process.env, SP2O_CONFIG_DIR: configDirectory }
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.ok(result.stdout.length >= 4, 'Native host did not return a framed error response');
    const framedLength = result.stdout.readUInt32LE(0);
    const framedError = JSON.parse(result.stdout.subarray(4, 4 + framedLength).toString());
    assert.equal(framedError.ok, false);
    assert.match(framedError.error, /Invalid native message header/);
  }
  assert.equal(sendNativeHostMessage({ action: 'configure', folderPath: vaultPath }, configDirectory).ok, true);
  const genericFolderStatus = sendNativeHostMessage({ action: 'ping' }, configDirectory);
  assert.equal(genericFolderStatus.folderName, 'Test Vault');
  assert.equal(genericFolderStatus.isObsidianVault, false, '一般 Markdown 資料夾不得要求 .obsidian');

  // Apple 備忘錄用假 osascript 驗證 location、upsert、0600 暫存檔與權限錯誤分類。
  const fakeOsascript = join(nativeTestRoot, 'fake-osascript.sh');
  const fakeNotesLog = join(nativeTestRoot, 'fake-notes.log');
  writeFileSync(fakeOsascript, `#!/bin/sh
if [ "\${SP2O_FAKE_DENY:-}" = "1" ]; then
  echo 'Not authorized to send Apple events. (-1743)' >&2
  exit 1
fi
case "$2" in
  *"repeat with noteAccount"*) printf 'account-local\\037我的 Mac\\037folder-test\\037社群貼文測試\\036' ;;
  *"set folderNotes to notes"*) printf '1\\036note-list\\037掃描測試\\0372026-08-01T01:00:00Z\\0372026-08-02T01:00:00Z\\037%s\\036' "\${SP2O_FAKE_BODY:-}" ;;
  *"return body of targetNote"*) printf '%s' "\${SP2O_FAKE_BODY:-}" ;;
  *"repeat with targetAttachment in attachments"*)
    printf '\\001\\002\\003' > "$6/attachment-1"
    printf 'image-01.jpg\\037%s\\036' "$6/attachment-1"
    ;;
  *"delete targetNote"*)
    case "\${SP2O_FAKE_BODY:-}" in
      *"$6"*) printf '' ;;
      *) printf 'SP2O_IDENTITY_MISMATCH' >&2; exit 1 ;;
    esac
    ;;
  *"set htmlPath"*)
    /usr/bin/ruby -e 'printf "%o\\n", File.stat(ARGV.fetch(0)).mode & 0777' "$8" > "\${SP2O_FAKE_LOG}"
    /bin/cat "$8" >> "\${SP2O_FAKE_LOG}"
    printf 'note-fake'
    ;;
  *) printf '' ;;
esac
`);
  chmodSync(fakeOsascript, 0o755);
  const fakeNotesEnv = {
    SP2O_OSASCRIPT: fakeOsascript,
    SP2O_FAKE_LOG: fakeNotesLog,
    LANG: 'C',
    LC_ALL: 'C'
  };
  assert.deepEqual(
    sendNativeHostMessage({ action: 'notesLocations' }, configDirectory, fakeNotesEnv).locations,
    [{
      accountId: 'account-local',
      accountName: '我的 Mac',
      folderId: 'folder-test',
      folderName: '社群貼文測試'
    }]
  );
  const fakeUpsert = sendNativeHostMessage({
    action: 'notesUpsert',
    accountId: 'account-local',
    folderId: 'folder-test',
    title: 'Unicode 測試',
    externalKey: 'x:1',
    html: '<h1>Unicode 測試</h1>',
    attachments: []
  }, configDirectory, fakeNotesEnv);
  assert.equal(fakeUpsert.noteId, 'note-fake');
  assert.match(readFileSync(fakeNotesLog, 'utf8'), /^600\n<h1>Unicode 測試<\/h1>$/);
  const notesBodyWithoutCustomAttribute = [
    '<div><h1>手改過的貼文</h1>',
    '<p><strong>來源：</strong><a href="https://x.com/author/status/123456">',
    'https://x.com/author/status/123456</a></p><p>使用者手動補充</p></div>'
  ].join('');
  const fakeNotesList = sendNativeHostMessage({
    action: 'notesListPosts',
    accountId: 'account-local',
    folderId: 'folder-test',
    cursor: 0,
    limit: 10
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: notesBodyWithoutCustomAttribute
  });
  assert.equal(fakeNotesList.ok, true, JSON.stringify(fakeNotesList));
  assert.doesNotMatch(
    readFileSync('native/host.rb', 'utf8'),
    /as «class isot»/,
    'Notes 日期不得依賴在部分 macOS 環境會失敗的 «class isot» 轉型'
  );
  assert.equal(fakeNotesList.entries.length, 1);
  assert.equal(fakeNotesList.entries[0].noteId, 'note-list');
  assert.equal(fakeNotesList.entries[0].createdAt, '2026-08-01T01:00:00Z');
  const fakeAttachmentHashes = sendNativeHostMessage({
    action: 'notesAttachmentHashes',
    accountId: 'account-local',
    noteId: 'note-edited',
    externalKey: 'x:123456'
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: notesBodyWithoutCustomAttribute
  });
  assert.deepEqual(fakeAttachmentHashes.hashes, [
    createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex')
  ]);
  const fakeMergedNotesBody = [
    '<div><strong>來源：</strong><ul>',
    '<li><a href="https://x.com/author/status/123456">X</a></li>',
    '<li><a href="https://www.threads.com/@author/post/ABC123">Threads</a></li>',
    '</ul></div>'
  ].join('');
  const fakeNotesRevision = `sha256:${createHash('sha256').update(fakeMergedNotesBody).digest('hex')}`;
  const fakeNotesMerge = sendNativeHostMessage({
    action: 'notesMergeDuplicates',
    accountId: 'account-local',
    folderId: 'folder-test',
    canonical: {
      noteId: 'note-canonical',
      externalKey: 'x:123456',
      revision: fakeNotesRevision,
      title: '合併後筆記',
      html: fakeMergedNotesBody
    },
    duplicates: [{
      noteId: 'note-duplicate',
      externalKey: 'threads:ABC123',
      revision: fakeNotesRevision
    }]
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: fakeMergedNotesBody
  });
  assert.equal(fakeNotesMerge.ok, true, JSON.stringify(fakeNotesMerge));
  assert.equal(fakeNotesMerge.merged, 1);
  assert.equal(sendNativeHostMessage({
    action: 'notesDelete',
    accountId: 'account-local',
    noteId: 'note-edited',
    externalKey: 'x:123456'
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: notesBodyWithoutCustomAttribute
  }).ok, true, 'Notes 清掉 data-sp2o-key 後，仍須以精確來源網址驗證並刪除');
  const wrongNotesIdentity = sendNativeHostMessage({
    action: 'notesDelete',
    accountId: 'account-local',
    noteId: 'note-edited',
    externalKey: 'x:123'
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: notesBodyWithoutCustomAttribute
  });
  assert.equal(wrongNotesIdentity.code, 'NOTES_IDENTITY_MISMATCH');
  assert.equal(sendNativeHostMessage({
    action: 'notesDelete',
    accountId: 'account-local',
    noteId: 'note-threads',
    externalKey: 'threads:ABC123'
  }, configDirectory, {
    ...fakeNotesEnv,
    SP2O_FAKE_BODY: '<div><strong>來源：</strong><a href="https://www.threads.com/@author/post/ABC123">來源</a></div>'
  }).ok, true, 'Threads 來源網址也必須能在 Notes 正規化 HTML 後通過身分驗證');
  const denied = sendNativeHostMessage(
    { action: 'notesLocations' },
    configDirectory,
    { ...fakeNotesEnv, SP2O_FAKE_DENY: '1' }
  );
  assert.equal(denied.code, 'AUTOMATION_DENIED');

  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/test.md',
    encoding: 'utf8',
    data: '---\nsource_url: "https://x.com/me/status/1001"\n---\n\n# native'
  }, configDirectory).ok, true);
  assert.equal(
    readFileSync(join(vaultPath, '個人創作', '社群推文', 'test.md'), 'utf8'),
    '---\nsource_url: "https://x.com/me/status/1001"\n---\n\n# native'
  );
  assert.deepEqual(sendNativeHostMessage({
    action: 'read',
    path: '個人創作/社群推文/test.md'
  }, configDirectory), {
    ok: true,
    data: '---\nsource_url: "https://x.com/me/status/1001"\n---\n\n# native'
  });
  assert.deepEqual(sendNativeHostMessage({
    action: 'readBinary',
    path: '個人創作/社群推文/test.md'
  }, configDirectory), {
    ok: true,
    data: Buffer.from('---\nsource_url: "https://x.com/me/status/1001"\n---\n\n# native').toString('base64')
  });

  // 補存比對要同時拿檔名與 source_url：後者才能在摘要空白不同時精準辨識同一則。
  const listed = sendNativeHostMessage({ action: 'list', path: '個人創作/社群推文' }, configDirectory);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.names, ['test.md']);
  assert.deepEqual(listed.entries, [{
    name: 'test.md',
    sourceUrl: 'https://x.com/me/status/1001'
  }]);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/發文/nested.md',
    encoding: 'utf8',
    data: '---\nsource_url: "https://x.com/me/status/1002"\n---\n'
  }, configDirectory).ok, true);
  const recursiveList = sendNativeHostMessage({
    action: 'list',
    path: '個人創作/社群推文',
    recursive: true
  }, configDirectory);
  assert.deepEqual(recursiveList.names.slice().sort(), ['test.md', '發文/nested.md']);
  assert.equal(
    recursiveList.entries.find(entry => entry.name === '發文/nested.md').sourceUrl,
    'https://x.com/me/status/1002'
  );
  // 不存在的資料夾要回空陣列，不能報錯——第一次補存時筆記夾可能還沒建立
  assert.deepEqual(
    sendNativeHostMessage({ action: 'list', path: '個人創作/還沒有這個資料夾' }, configDirectory),
    { ok: true, names: [], entries: [] }
  );

  // 最近 7 天留在根目錄；較舊的社群筆記移到 Archive/類型，並修正圖片相對路徑。
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/old-quote.md',
    encoding: 'utf8',
    data: [
      '---',
      'created: "2026-07-18 11:00"',
      'source: "x"',
      'source_url: "https://x.com/me/status/2001"',
      'status: "published"',
      'post_type: "quote"',
      '---',
      '',
      '![圖片](<../../附件/順筆/old/image-01.jpg>)'
    ].join('\n')
  }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/recent-post.md',
    encoding: 'utf8',
    data: [
      '---',
      'created: "2026-07-21 11:00"',
      'source: "x"',
      'source_url: "https://x.com/me/status/2002"',
      'status: "published"',
      'post_type: "post"',
      '---'
    ].join('\n')
  }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/old-threads.md',
    encoding: 'utf8',
    data: [
      '---',
      'created: "2026-07-18 11:00"',
      'source: "threads"',
      'status: "published"',
      '---'
    ].join('\n')
  }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/回覆/legacy-reply.md',
    encoding: 'utf8',
    data: [
      '---',
      'created: "2026-07-18 10:00"',
      'source: "x"',
      'source_url: "https://x.com/me/status/1999"',
      'status: "published"',
      'post_type: "reply"',
      'reply_to: "https://x.com/someone/status/1998"',
      '---'
    ].join('\n')
  }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/串文/manual-thread.md',
    encoding: 'utf8',
    data: '沒有 frontmatter 的舊手動串文',
    mtime: Math.floor(Date.parse('2025-12-27T00:00:00Z') / 1000)
  }, configDirectory).ok, true);
  const archived = sendNativeHostMessage({
    action: 'archiveSocialPosts',
    path: '個人創作/社群推文',
    olderThan: '2026-07-20T00:00:00+08:00'
  }, configDirectory);
  assert.deepEqual(archived.moved, [{
    from: '個人創作/社群推文/old-quote.md',
    to: '個人創作/社群推文/Archive/引用/old-quote.md'
  }, {
    from: '個人創作/社群推文/old-threads.md',
    to: '個人創作/社群推文/Archive/發文/old-threads.md'
  }, {
    from: '個人創作/社群推文/回覆/legacy-reply.md',
    to: '個人創作/社群推文/Archive/回覆/legacy-reply.md'
  }, {
    from: '個人創作/社群推文/串文/manual-thread.md',
    to: '個人創作/社群推文/Archive/串文/manual-thread.md'
  }]);
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', 'old-quote.md')),
    false
  );
  assert.match(
    readFileSync(join(vaultPath, '個人創作', '社群推文', 'Archive', '引用', 'old-quote.md'), 'utf8'),
    /<\.\.\/\.\.\/\.\.\/\.\.\/附件\/順筆\/old\/image-01\.jpg>/
  );
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', 'recent-post.md')),
    true
  );
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', 'old-threads.md')),
    false
  );
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', 'Archive', '發文', 'old-threads.md')),
    true
  );
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', '回覆')),
    false
  );
  assert.equal(
    existsSync(join(vaultPath, '個人創作', '社群推文', '串文')),
    false
  );

  // Chrome 啟動 Native Helper 時不帶 LANG，Ruby 的 filesystem encoding 會退成 US-ASCII，
  // 中文檔名會被標成非 UTF-8，與 UTF-8 正文串接時整批封存會沉默失敗。
  {
    const asciiLocale = { LANG: 'C', LC_ALL: 'C' };
    assert.equal(sendNativeHostMessage({
      action: 'write',
      path: '個人創作/社群推文/2026-07-20_1041_中文檔名的貼文🥳.md',
      encoding: 'utf8',
      data: [
        '---',
        'created: "2026-07-20 10:41"',
        'source: "x"',
        'source_url: "https://x.com/me/status/2079"',
        'status: "published"',
        'post_type: "post"',
        '---',
        '',
        '含中文與 emoji 🥳 的正文。',
        '',
        '![圖片 1](<../../附件/順筆/中文資料夾/image-01.jpg>)'
      ].join('\n')
    }, configDirectory).ok, true);
    const asciiLocaleArchive = sendNativeHostMessage({
      action: 'archiveSocialPosts',
      path: '個人創作/社群推文',
      olderThan: '2026-07-21T00:00:00+08:00'
    }, configDirectory, asciiLocale);
    assert.equal(
      asciiLocaleArchive.ok,
      true,
      `LANG=C 下封存中文檔名必須成功，實際錯誤：${asciiLocaleArchive.error}`
    );
    assert.deepEqual(asciiLocaleArchive.moved, [{
      from: '個人創作/社群推文/2026-07-20_1041_中文檔名的貼文🥳.md',
      to: '個人創作/社群推文/Archive/發文/2026-07-20_1041_中文檔名的貼文🥳.md'
    }]);
    assert.match(
      readFileSync(
        join(vaultPath, '個人創作', '社群推文', 'Archive', '發文', '2026-07-20_1041_中文檔名的貼文🥳.md'),
        'utf8'
      ),
      /<\.\.\/\.\.\/\.\.\/\.\.\/附件\/順筆\/中文資料夾\/image-01\.jpg>/,
      'LANG=C 下圖片相對連結仍要正確改寫'
    );
  }

  assert.equal(sendNativeHostMessage({
    action: 'exists',
    path: '個人創作/社群推文/test.md'
  }, configDirectory).exists, true);

  // 補存舊貼文時，檔案修改時間要對齊發文時間，依修改時間排序才不會全擠在最新
  const backfillMtime = Math.floor(Date.parse('2026-07-13T04:34:00Z') / 1000);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/backfilled.md',
    encoding: 'utf8',
    data: '# backfilled',
    mtime: backfillMtime
  }, configDirectory).ok, true);
  assert.equal(
    Math.floor(statSync(join(vaultPath, '個人創作', '社群推文', 'backfilled.md')).mtimeMs / 1000),
    backfillMtime
  );

  // 沒帶 mtime 時沿用寫入當下的時間，不得因此失敗
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/no-mtime.md',
    encoding: 'utf8',
    data: '# now'
  }, configDirectory).ok, true);
  assert.ok(
    Date.now() - statSync(join(vaultPath, '個人創作', '社群推文', 'no-mtime.md')).mtimeMs < 60000
  );

  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '附件/順筆/2026-07-18_1100_has-image/image-01.jpg',
    encoding: 'base64',
    data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64')
  }, configDirectory).ok, true);
  assert.deepEqual(
    readFileSync(join(mediaRoot, '2026-07-18_1100_has-image', 'image-01.jpg')),
    Buffer.from([0xff, 0xd8, 0xff])
  );

  mkdirSync(join(mediaRoot, '2026-07-01_0900_old-empty'), { recursive: true });
  // 摘要為空字串的資料夾（檔名以底線結尾）也必須能被清理
  mkdirSync(join(mediaRoot, '2026-07-02_0900_'), { recursive: true });
  mkdirSync(join(mediaRoot, 'unrelated-empty'), { recursive: true });
  const cleanup = sendNativeHostMessage({
    action: 'cleanEmptyMediaFolders',
    path: '附件/順筆'
  }, configDirectory);
  assert.equal(cleanup.removed, 2);
  assert.equal(existsSync(join(mediaRoot, '2026-07-01_0900_old-empty')), false);
  assert.equal(existsSync(join(mediaRoot, '2026-07-02_0900_')), false);
  assert.equal(existsSync(join(mediaRoot, 'unrelated-empty')), true);
  assert.equal(existsSync(join(mediaRoot, '2026-07-18_1100_has-image')), true);

  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '../outside.md',
    encoding: 'utf8',
    data: 'blocked'
  }, configDirectory).ok, false);
  assert.equal(sendNativeHostMessage({
    action: 'remove',
    path: '個人創作/社群推文/test.md'
  }, configDirectory).ok, true);
  assert.equal(existsSync(join(vaultPath, '個人創作', '社群推文', 'test.md')), false);
  assert.equal(sendNativeHostMessage({
    action: 'exists',
    path: '個人創作/社群推文/test.md'
  }, configDirectory).exists, false);
} finally {
  rmSync(nativeTestRoot, { recursive: true, force: true });
}

const xResponse = JSON.stringify({
  data: {
    create_tweet: {
      tweet_results: {
        result: {
          rest_id: '123456',
          core: { user_results: { result: { legacy: { screen_name: 'author' } } } },
          legacy: {
            full_text: '有兩張圖片',
            extended_entities: {
              media: [
                { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/first.jpg', ext_alt_text: '第一張' },
                { type: 'video', media_url_https: 'https://pbs.twimg.com/media/video-cover.jpg' },
                { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/second.png' }
              ]
            }
          }
        }
      }
    }
  }
});

const parsedX = common.parseCreateTweet(xResponse);
assert.equal(parsedX.url, 'https://x.com/author/status/123456');
assert.deepEqual(JSON.parse(JSON.stringify(parsedX.media)), [
  { url: 'https://pbs.twimg.com/media/first.jpg', alt: '第一張' },
  { url: 'https://pbs.twimg.com/media/second.png', alt: '圖片 3' }
]);

const threadsResponse = JSON.stringify({
  payload: {
    post: {
      pk: '987',
      code: 'ABC123',
      user: { username: 'author' },
      caption: { text: '' },
      carousel_media: [
        {
          accessibility_caption: '輪播第一張',
          image_versions2: { candidates: [
            { url: 'https://scontent.cdninstagram.com/small.jpg', width: 320, height: 320 },
            { url: 'https://scontent.cdninstagram.com/large.jpg', width: 1080, height: 1080 }
          ] }
        },
        {
          video_versions: [{ url: 'https://video.cdninstagram.com/video.mp4' }],
          image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/video-cover.jpg' }] }
        },
        {
          image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/second.webp', width: 800, height: 1000 }] }
        }
      ]
    }
  }
});

const parsedThreads = common.parseThreadsCreate(threadsResponse);
assert.equal(parsedThreads.url, 'https://www.threads.com/@author/post/ABC123');
assert.equal(parsedThreads.text, '');
assert.deepEqual(JSON.parse(JSON.stringify(parsedThreads.media)), [
  { url: 'https://scontent.cdninstagram.com/large.jpg', alt: '輪播第一張' },
  { url: 'https://scontent.cdninstagram.com/second.webp', alt: '圖片 3' }
]);

// Current threads.com publishing uses /api/v1/media/configure_text_post_app_feed/.
// Its response may expose permalink and media without user.username.
const threadsConfigureResponse = JSON.stringify({
  media: {
    pk: '989',
    code: 'CONFIGURE123',
    permalink: 'https://www.threads.com/@author/post/CONFIGURE123',
    caption: { text: '現行發文端點圖片' },
    media_type: 1,
    accessibility_caption: '現行 Threads 圖片',
    image_versions2: { candidates: [
      { url: 'https://scontent.cdninstagram.com/configure-small.jpg', width: 320, height: 240 },
      { url: 'https://scontent.cdninstagram.com/configure-large.jpg', width: 1440, height: 1080 }
    ] }
  },
  status: 'ok'
});

const parsedThreadsConfigure = common.parseThreadsCreate(threadsConfigureResponse);
assert.equal(parsedThreadsConfigure.url, 'https://www.threads.com/@author/post/CONFIGURE123');
assert.equal(parsedThreadsConfigure.text, '現行發文端點圖片');
assert.deepEqual(JSON.parse(JSON.stringify(parsedThreadsConfigure.media)), [
  { url: 'https://scontent.cdninstagram.com/configure-large.jpg', alt: '現行 Threads 圖片' }
]);

// Threads can return an image embedded in a text post under linked_inline_media
// instead of the top-level media fields.
const threadsInlineMediaResponse = JSON.stringify({
  data: {
    create_text_post: {
      post: {
        pk: '988',
        code: 'INLINE123',
        user: { username: 'author' },
        caption: { text: '內嵌圖片貼文' },
        media_type: 19,
        image_versions2: { candidates: [] },
        text_post_app_info: {
          linked_inline_media: {
            pk: 'media-1',
            media_type: 1,
            accessibility_caption: '內嵌圖片',
            image_versions2: { candidates: [
              { url: 'https://scontent.cdninstagram.com/inline-small.jpg', width: 320, height: 240 },
              { url: 'https://scontent.cdninstagram.com/inline-large.jpg', width: 1600, height: 1200 }
            ] }
          }
        }
      }
    }
  }
});

const parsedThreadsInlineMedia = common.parseThreadsCreate(threadsInlineMediaResponse);
assert.deepEqual(JSON.parse(JSON.stringify(parsedThreadsInlineMedia.media)), [
  { url: 'https://scontent.cdninstagram.com/inline-large.jpg', alt: '內嵌圖片' }
]);

function loadBackground(initialStored = {}, storageOptions = {}) {
  const storedBacking = {
    storageSchemaVersion: 3,
    storageProvider: 'markdown-folder',
    markdownFolderSettings: {
      basePath: '個人創作/社群推文',
      mediaPath: '附件/順筆',
      folderName: 'Test Vault'
    },
    obsidianRestSettings: {
      apiKey: 'test-key',
      port: 27123,
      basePath: '個人創作/社群推文',
      mediaPath: '附件/順筆'
    },
    appleNotesSettings: {},
    ...initialStored
  };
  // 舊測試的設定賦值映射到 v2 schema；production 不保留舊 schema fallback。
  const stored = new Proxy(storedBacking, {
    set(target, property, value) {
      if (property === 'storageMode') {
        target.storageProvider = value === 'rest' ? 'obsidian-rest' : 'markdown-folder';
        return true;
      }
      if (['apiKey', 'port', 'basePath', 'mediaPath'].includes(property)) {
        const key = target.storageProvider === 'obsidian-rest' ? 'obsidianRestSettings' : 'markdownFolderSettings';
        target[key] = { ...(target[key] || {}), [property]: value };
        return true;
      }
      if (['recentSaves', 'recentThreadContexts'].includes(property) && Array.isArray(value)) {
        target[property] = value.map((entry) => entry?.path && !entry.ref
          ? {
            ...entry,
            ref: {
              provider: target.storageProvider,
              path: entry.path,
              title: entry.filename || '',
              externalKey: entry.url || entry.path
            },
            path: undefined
          }
          : entry);
        return true;
      }
      if (String(property).startsWith('draftStatus_') && value?.path && !value.ref) {
        target[property] = {
          ...value,
          ref: {
            provider: target.storageProvider,
            path: value.path,
            title: value.filename || '',
            externalKey: `draft:${String(property).replace('draftStatus_', '')}`
          },
          path: undefined
        };
        return true;
      }
      target[property] = value;
      return true;
    }
  });
  const requests = [];
  const nativeMessages = [];
  const nativeFiles = new Map();
  const nativeNotes = new Map();
  let localMode = 'ok';
  let nativeMode = 'ok';
  let nativeNames = null;
  let nativeEntries = null;
  let nativeArchiveMoves = [];
  let restFiles = null;
  const alarmCreates = [];
  const alarmClears = [];
  const alarms = new Map((storageOptions.initialAlarms || []).map(alarm => [alarm.name, alarm]));
  const createdTabs = [];
  const removedTabs = [];
  const tabMessages = [];
  let nextTabId = 700;
  let alarmListener = null;
  let messageListener = null;
  let storageWriteCount = 0;

  function storageReadValue(key, value) {
    if (storageWriteCount === 0) return value;
    if (storageOptions.corruptReadBackKey === key) return undefined;
    if (!storageOptions.reorderReadBackObjects) return value;
    if (Array.isArray(value)) return value.map(item => storageReadValue(key, item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).reverse().map(property => [property, storageReadValue(key, value[property])])
    );
  }

  const chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: manifestVersion }),
      async sendNativeMessage(host, message) {
        assert.equal(host, 'com.lostshin.sun_pit');
        nativeMessages.push(message);
        if (storageOptions.nativeRequest) return storageOptions.nativeRequest(message);
        if (nativeMode === 'notes-unavailable' && String(message.action).startsWith('notes')) {
          return { ok: false, code: 'NOTES_UNAVAILABLE', error: 'Apple 備忘錄目前無法啟動' };
        }
        // rejected：host 有回應但拒絕（永久性錯誤，不可進離線佇列）
        if (nativeMode === 'rejected') {
          return { ok: false, error: 'Vault is not configured' };
        }
        if (nativeMode !== 'ok' && !(nativeMode === 'missing' && message.action === 'exists')) {
          throw new Error('Specified native messaging host not found');
        }
        if (message.action === 'ping') {
          return {
            ok: true,
            configured: true,
            version: '1.10.0',
            folderName: 'Test Vault',
            vaultName: 'Test Vault',
            isObsidianVault: true
          };
        }
        if (message.action === 'chooseVault') {
          return { ok: true, configured: true, version: '1.1.2', vaultName: 'Chosen Vault' };
        }
        if (message.action === 'exists') {
          return { ok: true, exists: nativeMode !== 'missing' && nativeFiles.has(message.path) };
        }
        if (message.action === 'read') {
          if (!nativeFiles.has(message.path)) return { ok: false, error: 'Vault file not found' };
          return { ok: true, data: nativeFiles.get(message.path) };
        }
        if (message.action === 'readBinary') {
          if (!nativeFiles.has(message.path)) return { ok: false, error: 'Vault file not found' };
          const value = nativeFiles.get(message.path);
          const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
          return { ok: true, data: bytes.toString('base64') };
        }
        if (message.action === 'write' && message.encoding !== 'base64') {
          nativeFiles.set(message.path, String(message.data || ''));
        }
        if (message.action === 'write' && message.encoding === 'base64') {
          nativeFiles.set(message.path, Buffer.from(String(message.data || ''), 'base64'));
        }
        if (message.action === 'remove') {
          nativeFiles.delete(message.path);
          return { ok: true };
        }
        // 舊版 Host 不認得 list，會回沒有 names 的結果；呼叫端必須能退回逐檔比對
        if (message.action === 'list') {
          if (!nativeNames) return { ok: true };
          const response = { ok: true, names: nativeNames };
          if (nativeEntries) response.entries = nativeEntries;
          return response;
        }
        if (message.action === 'archiveSocialPosts') {
          return { ok: true, moved: nativeArchiveMoves, skipped: [] };
        }
        if (message.action === 'notesLocations') {
          return {
            ok: true,
            locations: [{
              accountId: 'account-local',
              accountName: 'On My Mac',
              folderId: 'folder-test',
              folderName: 'SP2O Tests'
            }]
          };
        }
        if (message.action === 'notesExistsLocation') {
          return { ok: true, configured: message.folderId === 'folder-test', exists: message.folderId === 'folder-test' };
        }
        if (message.action === 'notesFind') {
          const identityPart = String(message.externalKey || '').split(':').pop();
          const found = [...nativeNotes.values()].find(note => (
            note.externalKey === message.externalKey || String(note.html || '').includes(identityPart)
          ));
          return found
            ? { ok: true, found: true, noteId: found.noteId, title: found.title, externalKey: found.externalKey }
            : { ok: true, found: false };
        }
        if (message.action === 'notesRead') {
          const note = nativeNotes.get(message.noteId);
          if (!note) return { ok: false, code: 'NOTES_NOT_FOUND', error: '找不到 Apple 備忘錄' };
          if (note.locked) return { ok: false, code: 'NOTES_LOCKED', error: 'Apple 備忘錄已鎖定' };
          return { ok: true, html: note.html, externalKey: note.externalKey };
        }
        if (message.action === 'notesListPosts') {
          const entries = [...nativeNotes.values()].slice(message.cursor || 0, (message.cursor || 0) + (message.limit || 10))
            .map(note => ({
              noteId: note.noteId,
              title: note.title,
              html: note.html,
              createdAt: note.createdAt || '2026-08-01T00:00:00+08:00',
              modifiedAt: note.modifiedAt || '2026-08-01T00:00:00+08:00'
            }));
          const next = (message.cursor || 0) + entries.length;
          return { ok: true, entries, nextCursor: next < nativeNotes.size ? next : null };
        }
        if (message.action === 'notesAttachmentHashes') {
          const note = nativeNotes.get(message.noteId);
          const entries = [];
          for (const attachment of note?.attachments || []) {
            const bytes = Buffer.from(String(attachment.data || ''), 'base64');
            const digest = await webcrypto.subtle.digest('SHA-256', bytes);
            const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
            entries.push({ name: attachment.name, hash });
          }
          return { ok: true, entries, hashes: entries.map(entry => entry.hash) };
        }
        if (message.action === 'notesUpsert') {
          const noteId = message.noteId || `note-${nativeNotes.size + 1}`;
          const previousAttachments = nativeNotes.get(noteId)?.attachments || [];
          const incomingNames = new Set((message.attachments || []).map(attachment => attachment.name));
          nativeNotes.set(noteId, {
            noteId,
            title: message.title,
            html: message.html,
            externalKey: message.externalKey,
            attachments: [
              ...previousAttachments.filter(attachment => !incomingNames.has(attachment.name)),
              ...(message.attachments || [])
            ]
          });
          return {
            ok: true,
            noteId,
            title: message.title,
            savedMedia: (message.attachments || []).length,
            failedMedia: 0
          };
        }
        if (message.action === 'notesExists') {
          const note = nativeNotes.get(message.noteId);
          return { ok: true, exists: !!note && note.externalKey === message.externalKey };
        }
        if (message.action === 'notesDelete') {
          nativeNotes.delete(message.noteId);
          return { ok: true };
        }
        if (message.action === 'notesMergeDuplicates') {
          const note = nativeNotes.get(message.canonical.noteId);
          if (!note) return { ok: false, code: 'NOTES_NOT_FOUND', error: '找不到 Apple 備忘錄' };
          note.html = message.canonical.html;
          for (const duplicate of message.duplicates || []) nativeNotes.delete(duplicate.noteId);
          return { ok: true, noteId: note.noteId, merged: (message.duplicates || []).length, savedMedia: 0 };
        }
        if (message.action === 'notesShow') return { ok: true };
        if (message.action === 'cleanEmptyMediaFolders') return { ok: true, removed: 1 };
        return { ok: true };
      },
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: storageReadValue(keys, stored[keys]) };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map(key => [key, storageReadValue(key, stored[key])]));
          }
          return { ...stored };
        },
        async set(values) {
          Object.assign(stored, values);
          storageWriteCount++;
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        }
      }
    },
    alarms: {
      create(name, options) {
        alarmCreates.push({ name, options });
        alarms.set(name, { name, ...options });
      },
      clear(name) {
        alarmClears.push(name);
        alarms.delete(name);
      },
      get(name, callback) { callback(alarms.get(name) || null); },
      onAlarm: {
        addListener(listener) { alarmListener = listener; }
      }
    },
    tabs: {
      async create(options) {
        const tab = { id: nextTabId++, ...options };
        createdTabs.push(tab);
        return tab;
      },
      async remove(tabId) {
        removedTabs.push(tabId);
      },
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message });
        callback?.({ ok: true });
      }
    },
    notifications: { create() {} }
  };

  async function fetchStub(url, init = {}) {
    if (String(url).startsWith('https://pbs.twimg.com/media/good')) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      });
    }
    if (String(url).startsWith('https://scontent.cdninstagram.com/configure-large')) {
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200,
        headers: { 'content-type': 'image/webp' }
      });
    }
    if (String(url).startsWith('https://pbs.twimg.com/media/missing')) {
      return new Response('', { status: 404 });
    }
    if (String(url).startsWith('http://127.0.0.1:27123/vault/')) {
      requests.push({ url: String(url), init });
      if (localMode === 'offline') throw new TypeError('Failed to fetch');
      if (localMode === 'unauthorized') return new Response(null, { status: 401 });
      if (localMode === 'missing' && init.method === 'GET') return new Response(null, { status: 404 });
      const encodedPath = String(url).split('/vault/')[1] || '';
      const directoryRequest = encodedPath.endsWith('/');
      const vaultPath = decodeURIComponent(directoryRequest ? encodedPath.slice(0, -1) : encodedPath);
      if ((init.method || 'GET') === 'GET' && directoryRequest) {
        const prefix = vaultPath ? `${vaultPath}/` : '';
        const files = [...new Set([...(restFiles || new Map()).keys()]
          .filter(path => path.startsWith(prefix))
          .map((path) => {
            const remainder = path.slice(prefix.length);
            const slash = remainder.indexOf('/');
            return slash >= 0 ? `${remainder.slice(0, slash)}/` : remainder;
          }).filter(Boolean))];
        return Response.json({ files });
      }
      if ((init.method || 'GET') === 'GET') {
        return restFiles?.has(vaultPath)
          ? new Response(restFiles.get(vaultPath), { status: 200, headers: { 'content-type': 'text/markdown' } })
          : new Response(null, { status: 404 });
      }
      if (init.method === 'PUT') {
        if (!restFiles) restFiles = new Map();
        restFiles.set(vaultPath, typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('binary'));
        return new Response(null, { status: 204 });
      }
      if (init.method === 'DELETE') {
        const existed = restFiles?.delete(vaultPath) === true;
        return new Response(null, { status: existed ? 204 : 404 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }

  const sandbox = {
    console,
    chrome,
    crypto: webcrypto,
    fetch: fetchStub,
    Response,
    URL,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    Date,
    btoa,
    atob,
    setTimeout,
    clearTimeout
  };
  const context = vm.createContext(sandbox);
  // service worker 的 importScripts：在同一 context 內載入共用檔
  sandbox.importScripts = (...files) => {
    for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), context);
  };
  vm.runInContext(readFileSync('background.js', 'utf8'), context);
  return {
    alarmCreates,
    alarmClears,
    context,
    createdTabs,
    nativeMessages,
    nativeFiles,
    removedTabs,
    requests,
    stored,
    tabMessages,
    fireAlarm(name) { alarmListener?.({ name }); },
    fireMessage(message) { messageListener?.(message, {}, () => {}); },
    waitForTasks() { return vm.runInContext('Promise.all(Object.values(taskChains))', context); },
    setNativeMode(mode) { nativeMode = mode; },
    setNativeNames(names) { nativeNames = names; },
    setNativeListing(names, entries) {
      nativeNames = names;
      nativeEntries = entries;
    },
    setNativeArchiveMoves(moves) { nativeArchiveMoves = moves; },
    setRestFile(path, data) {
      if (!restFiles) restFiles = new Map();
      restFiles.set(path, data);
    },
    getRestFile(path) { return restFiles?.get(path); },
    hasRestFile(path) { return restFiles?.has(path) === true; },
    getRestPaths() { return [...(restFiles || new Map()).keys()]; },
    setNativeFile(path, data) { nativeFiles.set(path, data); },
    setNativeNote(note) { nativeNotes.set(note.noteId, { ...note }); },
    getNativeNote(noteId) { return nativeNotes.get(noteId); },
    getNativeNotes() { return [...nativeNotes.values()]; },
    setLocalMode(mode) { localMode = mode; }
  };
}

const background = loadBackground();
const legacyMigration = background.context.SP2OStorage.migrationFor({
  storageMode: 'rest',
  apiKey: 'legacy-secret',
  port: 27124,
  basePath: '舊筆記',
  mediaPath: '舊附件',
  recentSaves: [{ filename: 'old.md', path: '舊筆記/old.md', platform: 'x', url: 'https://x.com/me/status/1' }],
  offlineQueue: [{
    filename: 'queued.md',
    path: '舊筆記/queued.md',
    platform: 'x',
    markdown: '# 尚未補存'
  }]
});
assert.equal(legacyMigration.updates.storageProvider, 'obsidian-rest');
assert.equal(legacyMigration.updates.obsidianRestSettings.apiKey, 'legacy-secret');
assert.equal(legacyMigration.updates.recentSaves[0].ref.provider, 'obsidian-rest');
assert.equal(legacyMigration.updates.offlineQueue[0].data.rawMarkdown, '# 尚未補存');
assert.equal('markdown' in legacyMigration.updates.offlineQueue[0], false);
assert.equal(
  background.context.SP2OStorage.migrationFor({ storageSchemaVersion: 3 }).changed,
  false,
  'schema migration 必須可重跑且不重複改寫'
);
assert.equal(background.context.SP2OStorage.migrationFor({ storageSchemaVersion: 2 }).changed, true);
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.SP2OStorage.migrationFor({ storageSchemaVersion: 2 }).updates.contentDedupeIndex)),
  {}
);
for (const providerId of ['markdown-folder', 'obsidian-rest', 'apple-notes']) {
  const adapter = background.context.getProvider({ storageProvider: providerId });
  for (const method of ['check', 'saveDraft', 'savePublished', 'findBySource', 'exists', 'delete', 'open']) {
    assert.equal(typeof adapter[method], 'function', `${providerId} 必須實作 ${method}`);
  }
}
assert.equal(background.context.getProvider({ storageProvider: 'markdown-folder' }).capabilities.archive, true);
assert.equal(background.context.getProvider({ storageProvider: 'obsidian-rest' }).capabilities.archive, true);
assert.equal(background.context.getProvider({ storageProvider: 'apple-notes' }).capabilities.archive, false);
for (const providerId of ['markdown-folder', 'obsidian-rest', 'apple-notes']) {
  const adapter = background.context.getProvider({ storageProvider: providerId });
  for (const method of ['scanPublished', 'mergeDuplicateGroup']) {
    assert.equal(typeof adapter[method], 'function', `${providerId} 必須實作 ${method}`);
  }
}
const migratedBackground = loadBackground({
  storageSchemaVersion: undefined,
  storageProvider: undefined,
  markdownFolderSettings: undefined,
  obsidianRestSettings: undefined,
  appleNotesSettings: undefined,
  storageMode: 'rest',
  apiKey: 'migrated-key',
  port: 27124,
  basePath: '遷移筆記',
  mediaPath: '遷移附件',
  recentSaves: [{ filename: 'legacy.md', path: '遷移筆記/legacy.md', platform: 'x' }]
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(migratedBackground.stored.storageSchemaVersion, 3);
assert.equal(migratedBackground.stored.storageProvider, 'obsidian-rest');
assert.equal(migratedBackground.stored.obsidianRestSettings.apiKey, 'migrated-key');
assert.equal(migratedBackground.stored.recentSaves[0].ref.path, '遷移筆記/legacy.md');
for (const oldKey of ['storageMode', 'apiKey', 'port', 'basePath', 'mediaPath', 'vaultName']) {
  assert.equal(oldKey in migratedBackground.stored, false, `migration 完成後要移除 ${oldKey}`);
}

const reorderedMigrationBackground = loadBackground({
  storageSchemaVersion: undefined,
  storageProvider: undefined,
  markdownFolderSettings: undefined,
  obsidianRestSettings: undefined,
  appleNotesSettings: undefined,
  storageMode: 'native',
  basePath: '順序測試',
  mediaPath: '順序測試附件',
  recentSaves: [{
    filename: 'order.md',
    path: '順序測試/order.md',
    platform: 'x',
    url: 'https://x.com/me/status/order'
  }]
}, { reorderReadBackObjects: true });
await assert.doesNotReject(
  () => reorderedMigrationBackground.context.ensureStorageSchema(),
  'storage 讀回物件 key 順序不同時，內容相同的 migration 不得被誤判失敗'
);
assert.equal(reorderedMigrationBackground.stored.storageSchemaVersion, 3);
assert.equal(reorderedMigrationBackground.stored.recentSaves[0].ref.path, '順序測試/order.md');
assert.equal('basePath' in reorderedMigrationBackground.stored, false);

const corruptedMigrationBackground = loadBackground({
  storageSchemaVersion: undefined,
  storageProvider: undefined,
  markdownFolderSettings: undefined,
  obsidianRestSettings: undefined,
  appleNotesSettings: undefined,
  storageMode: 'rest',
  apiKey: 'must-remain',
  basePath: '損毀測試'
}, { corruptReadBackKey: 'storageProvider' });
await assert.rejects(
  () => corruptedMigrationBackground.context.ensureStorageSchema(),
  /儲存設定升級讀回驗證失敗/,
  '真正缺少讀回值時仍必須停止 migration'
);
assert.equal(corruptedMigrationBackground.stored.storageSchemaVersion, undefined);
assert.equal(corruptedMigrationBackground.stored.apiKey, 'must-remain');
assert.equal(corruptedMigrationBackground.stored.basePath, '損毀測試');

const interruptedMigrationBackground = loadBackground({
  storageSchemaVersion: 2,
  storageProvider: 'obsidian-rest',
  obsidianRestSettings: {
    apiKey: 'already-migrated',
    port: 27124,
    basePath: '已轉換筆記',
    mediaPath: '已轉換附件'
  },
  storageMode: 'rest',
  apiKey: 'legacy-copy',
  basePath: '舊設定副本'
});
await assert.doesNotReject(
  () => interruptedMigrationBackground.context.ensureStorageSchema(),
  '舊版 migration 已寫入 schema version、但尚未移除舊 keys 時必須可自動復原'
);
assert.equal(interruptedMigrationBackground.stored.obsidianRestSettings.apiKey, 'already-migrated');
assert.equal('storageMode' in interruptedMigrationBackground.stored, false);
assert.equal('apiKey' in interruptedMigrationBackground.stored, false);
assert.equal('basePath' in interruptedMigrationBackground.stored, false);
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.nativeErrorResponse(
    new Error('Specified native messaging host not found')
  ))),
  {
    ok: false,
    code: 'NATIVE_HOST_NOT_FOUND',
    error: '找不到本機 Helper。Chrome 重新安裝後，請再次執行 Helper 安裝程式；原本的資料夾設定會保留。'
  },
  'Chrome 移除 Native Messaging manifest 時，應回傳可採取行動的中文錯誤'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.nativeErrorResponse(
    new Error('Access to the specified native messaging host is forbidden.')
  ))),
  {
    ok: false,
    code: 'NATIVE_HOST_FORBIDDEN',
    error: '本機 Helper 尚未授權這個擴充功能。請重新執行最新版 Helper 安裝程式。'
  },
  'Helper 未授權目前 extension ID 時，應引導使用者重新安裝最新版 Helper'
);
const oldHostActionError = new Error('Unknown native host action');
oldHostActionError.nativeResponse = {
  ok: false,
  error: 'Unknown native host action',
  version: '1.7.0'
};
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.nativeErrorResponse(oldHostActionError))),
  {
    ok: false,
    code: 'NATIVE_HOST_UPDATE_REQUIRED',
    error: '本機 Helper 版本過舊（目前 1.7.0，需要 1.10.0 以上）。請重新執行最新版 Helper 安裝程式，再重新載入擴充功能。',
    currentVersion: '1.7.0',
    requiredVersion: '1.10.0'
  },
  '舊版 Host 不認得 Apple 備忘錄 action 時，必須回傳可採取行動的升級提示'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.nativeHostStatusResponse({
    ok: true,
    configured: true,
    version: '1.7.0'
  }))),
  {
    ok: false,
    code: 'NATIVE_HOST_UPDATE_REQUIRED',
    error: '本機 Helper 版本過舊（目前 1.7.0，需要 1.10.0 以上）。請重新執行最新版 Helper 安裝程式，再重新載入擴充功能。',
    currentVersion: '1.7.0',
    requiredVersion: '1.10.0'
  },
  'Popup 連線檢查必須在使用 Apple 備忘錄前主動辨識舊版 Host'
);
background.stored.storageProvider = 'markdown-folder';
background.stored.mediaPath = '附件/順筆';
await background.context.startNativeMaintenance();
assert.ok(background.alarmCreates.some(item => item.name === 'sp2o-vault-maintenance'));
assert.equal(
  background.alarmCreates.some(item => item.name === 'sp2o-obsidian-archive'),
  true,
  '本機 Markdown 資料夾也必須每日整理社群貼文'
);
assert.deepEqual(JSON.parse(JSON.stringify(background.nativeMessages.at(-1))), {
  action: 'cleanEmptyMediaFolders',
  path: '附件/順筆'
});
{
  const markdownArchiveBackground = loadBackground({ storageProvider: 'markdown-folder' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(
    markdownArchiveBackground.alarmCreates.some(item => item.name === 'sp2o-obsidian-archive'),
    '本機 Markdown 啟動時必須建立每日封存 alarm'
  );
  markdownArchiveBackground.stored.recentSaves = [{
    filename: 'old.md',
    path: '個人創作/社群推文/old.md',
    platform: 'x'
  }];
  markdownArchiveBackground.setNativeArchiveMoves([{
    from: '個人創作/社群推文/old.md',
    to: '個人創作/社群推文/Archive/發文/old.md'
  }]);
  assert.equal(await markdownArchiveBackground.context.archiveOldSocialPosts({
    storageProvider: 'markdown-folder',
    basePath: '個人創作/社群推文'
  }, '2026-07-20T00:00:00+08:00'), 1);
  assert.equal(
    markdownArchiveBackground.stored.recentSaves[0].ref.path,
    '個人創作/社群推文/Archive/發文/old.md',
    'Markdown 封存後必須同步更新最近儲存 ref'
  );
}

// Archive bookkeeping must stay in the destination that actually moved files.
{
  const app = loadBackground();
  await new Promise(resolve => setImmediate(resolve));
  const settings = await app.context.getStorageSettings();
  const scope = app.context.dedupeScopeKey(settings);
  const from = '個人創作/社群推文/old.md';
  const to = '個人創作/社群推文/Archive/發文/old.md';
  const entry = { ref: { provider: 'markdown-folder', path: from }, sources: [] };
  app.stored.contentDedupeIndex = { [scope]: { hash: [entry] }, other: { hash: [entry] } };
  app.stored.recentSaves = [{ ref: { provider: 'obsidian-rest', path: from } }];
  app.setNativeArchiveMoves([{ from, to }]);
  await app.context.archiveOldSocialPosts(settings);
  assert.equal(app.stored.contentDedupeIndex.other.hash[0].ref.path, from,
    '封存不可改寫其他 location 的索引');
  assert.equal(app.stored.recentSaves[0].ref.path, from, '封存不可改寫其他 provider 的 recent');
  assert.equal(app.stored.contentDedupeIndex[scope].hash[0].ref.path, to);
  let status = await app.context.getMaintenanceStatus();
  assert.equal(status.archive.state, 'success');
  assert.equal(status.archive.moved, 1);
  app.setNativeMode('rejected');
  await assert.rejects(app.context.archiveOldSocialPosts(settings));
  status = await app.context.getMaintenanceStatus();
  assert.equal(status.archive.state, 'error');
  assert.match(status.archive.error, /configured/);
  assert.ok(status.archive.lastSuccessAt, '失敗後仍保留最後成功時間');
  app.stored.storageProvider = 'apple-notes';
  status = await app.context.getMaintenanceStatus();
  assert.equal(status.supportsArchive, false);
  assert.equal(status.archive, null, '切換目的地不可顯示前一目的地的封存狀態');
}

const restArchiveBackground = loadBackground({ storageProvider: 'obsidian-rest' });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(
  JSON.parse(JSON.stringify(
    restArchiveBackground.alarmCreates.find(item => item.name === 'sp2o-obsidian-archive')
  )),
  {
    name: 'sp2o-obsidian-archive',
    options: { delayInMinutes: 1, periodInMinutes: 1440 }
  }
);
const staleArchiveAlarmBackground = loadBackground({ storageProvider: 'obsidian-rest' }, {
  initialAlarms: [{
    name: 'sp2o-weekly-archive',
    delayInMinutes: 10080,
    periodInMinutes: 10080
  }]
});
await new Promise(resolve => setImmediate(resolve));
assert.ok(
  staleArchiveAlarmBackground.alarmCreates.some(item => (
    item.name === 'sp2o-obsidian-archive'
      && item.options.delayInMinutes === 1
      && item.options.periodInMinutes === 1440
  )),
  '升級前留下的七日 alarm 必須改成啟動後一分鐘補跑、之後每日執行'
);
assert.ok(
  staleArchiveAlarmBackground.alarmClears.includes('sp2o-weekly-archive'),
  '2.15.7 留下的錯誤 provider alarm 必須移除'
);

// popup 按「儲存設定」會送 RETRY_QUEUE；具封存能力的目的地不得被順手關掉每日封存。
{
  const savedSettingsBackground = loadBackground({ storageProvider: 'markdown-folder' });
  await new Promise(resolve => setImmediate(resolve));
  savedSettingsBackground.alarmClears.length = 0;
  savedSettingsBackground.fireMessage({ type: 'RETRY_QUEUE' });
  await savedSettingsBackground.waitForTasks();
  assert.equal(
    savedSettingsBackground.alarmClears.includes('sp2o-obsidian-archive'),
    false,
    '本機 Markdown 資料夾儲存設定後不得清掉每日封存 alarm'
  );
  assert.ok(
    savedSettingsBackground.alarmCreates.some(item => item.name === 'sp2o-obsidian-archive'),
    '本機 Markdown 資料夾儲存設定後必須維持每日封存 alarm'
  );
}
{
  const notesSettingsBackground = loadBackground({ storageProvider: 'apple-notes' });
  await new Promise(resolve => setImmediate(resolve));
  notesSettingsBackground.fireMessage({ type: 'RETRY_QUEUE' });
  await notesSettingsBackground.waitForTasks();
  assert.ok(
    notesSettingsBackground.alarmClears.includes('sp2o-obsidian-archive'),
    'Apple 備忘錄不支援封存，儲存設定後必須關掉每日封存 alarm'
  );
}
restArchiveBackground.stored.recentSaves = [{
  filename: 'old.md',
  path: '個人創作/社群推文/old.md',
  platform: 'x'
}];
restArchiveBackground.stored.recentThreadContexts = [{
  filename: 'old.md',
  path: '個人創作/社群推文/old.md',
  platform: 'x'
}];
restArchiveBackground.setRestFile('個人創作/社群推文/old.md', [
  '---',
  'created: "2026-07-18 11:00"',
  'source: "x"',
  'source_url: "https://x.com/me/status/2001"',
  'status: "published"',
  'post_type: "quote"',
  '---',
  '',
  '![圖片](<../../附件/順筆/old/image-01.jpg>)'
].join('\n'));
assert.equal(await restArchiveBackground.context.archiveOldSocialPosts({
  storageProvider: 'obsidian-rest',
  apiKey: 'test-key',
  port: 27123,
  basePath: '個人創作/社群推文'
}, '2026-07-20T00:00:00+08:00'), 1);
assert.equal(restArchiveBackground.hasRestFile('個人創作/社群推文/old.md'), false);
assert.match(
  restArchiveBackground.getRestFile('個人創作/社群推文/Archive/引用/old.md'),
  /<\.\.\/\.\.\/\.\.\/\.\.\/附件\/順筆\/old\/image-01\.jpg>/
);
assert.equal(
  restArchiveBackground.stored.recentSaves[0].ref.path,
  '個人創作/社群推文/Archive/引用/old.md'
);
assert.equal(
  restArchiveBackground.stored.recentThreadContexts[0].ref.path,
  '個人創作/社群推文/Archive/引用/old.md'
);
assert.equal(await restArchiveBackground.context.archiveOldSocialPosts({
  storageProvider: 'obsidian-rest',
  apiKey: 'test-key',
  port: 27123,
  basePath: '個人創作/社群推文'
}, '2026-07-20T00:00:00+08:00'), 0, 'Obsidian 封存重跑必須冪等');

restArchiveBackground.setRestFile('個人創作/社群推文/scheduled.md', [
  '---',
  'created: "2026-07-18 12:00"',
  'source: "threads"',
  'status: "published"',
  '---'
].join('\n'));
restArchiveBackground.fireAlarm('sp2o-obsidian-archive');
await restArchiveBackground.waitForTasks();
assert.equal(
  restArchiveBackground.hasRestFile('個人創作/社群推文/Archive/發文/scheduled.md'),
  true,
  'Obsidian 封存 alarm 到期時必須透過 Local REST API 整理貼文'
);
assert.equal(await background.context.archiveOldSocialPosts({
  storageProvider: 'markdown-folder',
  basePath: '個人創作/社群推文'
}), 0);

// Native Host 寫入比輸入速度慢時，只保留最新快照；舊草稿不得在平台佇列內越積越多。
const coalescedDraftBackground = loadBackground();
coalescedDraftBackground.stored.storageProvider = 'markdown-folder';
coalescedDraftBackground.stored.basePath = '個人創作/社群推文';
const firstDraftWrite = coalescedDraftBackground.context.scheduleDraftSave({
  content: '只有前半',
  platform: 'x',
  timestamp: '2026-07-26T07:30:00.000Z'
}, 1);
coalescedDraftBackground.context.scheduleDraftSave({
  content: '這才是完整貼文',
  platform: 'x',
  timestamp: '2026-07-26T07:30:00.100Z'
}, 1);
coalescedDraftBackground.context.scheduleDraftSave({
  content: '這才是完整貼文，而且是最後快照',
  platform: 'x',
  timestamp: '2026-07-26T07:30:00.200Z'
}, 1);
await firstDraftWrite;
const coalescedWrites = coalescedDraftBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(coalescedWrites.length, 1);
assert.match(coalescedWrites[0].data, /這才是完整貼文，而且是最後快照/);

// 發佈等待 API 的期間可能又排入較新 timestamp 的同篇草稿。正式檔成功後，
// 同一 composer session 的遲到訊息不得把已刪除的草稿重新建立。
const publishedSessionBackground = loadBackground();
publishedSessionBackground.stored.storageProvider = 'markdown-folder';
publishedSessionBackground.stored.basePath = '個人創作/社群推文';
const publishedSessionId = 'x:test-session:1';
await publishedSessionBackground.context.handleSaveDraft({
  content: '發佈前的完整草稿',
  platform: 'x',
  timestamp: '2026-07-26T08:00:00.000Z',
  draftSessionId: publishedSessionId
}, null);
assert.equal(
  publishedSessionBackground.stored.draftStatus_x.draftSessionId,
  publishedSessionId
);
assert.equal(await publishedSessionBackground.context.handlePublishDraft({
  content: '發佈前的完整草稿',
  platform: 'x',
  url: 'https://x.com/author/status/3001',
  timestamp: '2026-07-26T08:00:00.100Z',
  draftSessionId: publishedSessionId
}, null), true);
assert.equal('draftStatus_x' in publishedSessionBackground.stored, false);
assert.equal(
  publishedSessionBackground.stored.publishedDraftSession_x.id,
  publishedSessionId
);
const writesAfterPublish = publishedSessionBackground.nativeMessages
  .filter(message => message.action === 'write').length;
await publishedSessionBackground.context.handleSaveDraft({
  content: '發佈後才送達的同篇草稿',
  platform: 'x',
  timestamp: new Date(Date.now() + 1000).toISOString(),
  draftSessionId: publishedSessionId
}, null);
assert.equal(
  publishedSessionBackground.nativeMessages.filter(message => message.action === 'write').length,
  writesAfterPublish,
  '同一 session 的遲到草稿不得重新寫入'
);
await publishedSessionBackground.context.handleSaveDraft({
  content: '下一篇的新草稿',
  platform: 'x',
  timestamp: new Date(Date.now() + 2000).toISOString(),
  draftSessionId: 'x:test-session:2'
}, null);
assert.equal(
  publishedSessionBackground.nativeMessages.filter(message => message.action === 'write').length,
  writesAfterPublish + 1,
  '新的 composer session 仍須正常儲存'
);

// MV3 service worker 重啟後記憶體會清空；storage 中的 session 仍須阻止舊草稿復活。
const restartedSessionBackground = loadBackground({
  storageProvider: 'markdown-folder',
  basePath: '個人創作/社群推文',
  publishedDraftSession_x: publishedSessionBackground.stored.publishedDraftSession_x
});
await restartedSessionBackground.context.handleSaveDraft({
  content: '重啟後才送達的同篇草稿',
  platform: 'x',
  timestamp: new Date(Date.now() + 3000).toISOString(),
  draftSessionId: publishedSessionId
}, null);
assert.equal(
  restartedSessionBackground.nativeMessages.some(message => message.action === 'write'),
  false
);

// X 發佈後會用新 editor node 重建尚在移除中的串文，可能因此產生新的 session ID。
// 同分頁的 DOM 收尾期間仍須攔下；其他分頁的真正草稿不可被一起擋掉。
const rerenderedSessionBackground = loadBackground();
rerenderedSessionBackground.stored.storageProvider = 'markdown-folder';
rerenderedSessionBackground.stored.basePath = '個人創作/社群推文';
await rerenderedSessionBackground.context.handlePublishDraft({
  content: '三則相同內容\n\n---\n\n三則相同內容\n\n---\n\n三則相同內容',
  thread: ['三則相同內容', '三則相同內容', '三則相同內容'],
  platform: 'x',
  url: 'https://x.com/author/status/3003',
  timestamp: '2026-07-26T08:01:30.000Z',
  draftSessionId: 'x:published-editor'
}, 21);
const rerenderedWritesAfterPublish = rerenderedSessionBackground.nativeMessages
  .filter(message => message.action === 'write').length;
await rerenderedSessionBackground.context.handleSaveDraft({
  content: '三則相同內容\n\n---\n\n三則相同內容',
  thread: ['三則相同內容', '三則相同內容'],
  platform: 'x',
  timestamp: new Date(Date.now() + 1000).toISOString(),
  draftSessionId: 'x:rerendered-editor'
}, 21);
assert.equal(
  rerenderedSessionBackground.nativeMessages.filter(message => message.action === 'write').length,
  rerenderedWritesAfterPublish,
  '同分頁重建 editor 所產生的新 session 不得把已刪草稿寫回'
);
const restartedRerenderedBackground = loadBackground({
  storageProvider: 'markdown-folder',
  basePath: '個人創作/社群推文',
  publishedDraftSession_x: rerenderedSessionBackground.stored.publishedDraftSession_x
});
await restartedRerenderedBackground.context.handleSaveDraft({
  content: 'service worker 重啟後才到達的 DOM 收尾',
  platform: 'x',
  timestamp: new Date(Date.now() + 1000).toISOString(),
  draftSessionId: 'x:rerendered-after-restart'
}, 21);
assert.equal(
  restartedRerenderedBackground.nativeMessages.some(message => message.action === 'write'),
  false,
  'service worker 重啟後仍須攔下同分頁的 DOM 收尾'
);
await rerenderedSessionBackground.context.handleSaveDraft({
  content: '另一個 X 分頁的草稿',
  platform: 'x',
  timestamp: new Date(Date.now() + 1000).toISOString(),
  draftSessionId: 'x:other-tab'
}, 22);
assert.equal(
  rerenderedSessionBackground.nativeMessages.filter(message => message.action === 'write').length,
  rerenderedWritesAfterPublish + 1,
  '另一個分頁的新草稿仍須正常儲存'
);
const settledComposerBackground = loadBackground({
  storageProvider: 'markdown-folder',
  basePath: '個人創作/社群推文',
  publishedDraftSession_x: {
    id: 'x:settled-published-editor',
    publishedAt: Date.now() - 2001,
    tabId: 21
  }
});
await settledComposerBackground.context.handleSaveDraft({
  content: 'DOM 收尾期過後的新草稿',
  platform: 'x',
  timestamp: new Date().toISOString(),
  draftSessionId: 'x:new-after-settle'
}, 21);
assert.equal(
  settledComposerBackground.nativeMessages.some(message => message.action === 'write'),
  true,
  'DOM 收尾期結束後，同分頁的新草稿必須恢復儲存'
);

// 若使用者已開啟下一個 composer，較早貼文的清理不得刪掉新 session 草稿。
const separateSessionBackground = loadBackground();
separateSessionBackground.stored.storageProvider = 'markdown-folder';
separateSessionBackground.stored.basePath = '個人創作/社群推文';
separateSessionBackground.stored.draftStatus_x = {
  path: '個人創作/社群推文/_草稿_Twitter.md',
  draftSessionId: 'x:new-composer'
};
await separateSessionBackground.context.handlePublishDraft({
  content: '較早發佈的貼文',
  platform: 'x',
  url: 'https://x.com/author/status/3002',
  timestamp: '2026-07-26T08:01:00.000Z',
  draftSessionId: 'x:old-composer'
}, null);
assert.equal(
  separateSessionBackground.nativeMessages.some(message => message.action === 'remove'),
  false
);
assert.equal(
  separateSessionBackground.stored.draftStatus_x.draftSessionId,
  'x:new-composer'
);
const postData = {
  content: '圖片同步測試',
  platform: 'x',
  url: 'https://x.com/author/status/123456',
  timestamp: '2026-07-18T11:00:00+08:00',
  media: [
    { url: 'https://pbs.twimg.com/media/good.jpg', alt: '成功圖片' },
    { url: 'https://pbs.twimg.com/media/missing.jpg', alt: '失敗圖片' }
  ]
};
const filename = '2026-07-18_1100_圖片同步測試.md';
const path = `個人創作/社群推文/${filename}`;
const settings = {
  storageProvider: 'obsidian-rest',
  apiKey: 'test-key',
  port: 27123,
  basePath: '個人創作/社群推文',
  mediaPath: '附件/順筆'
};

const appleNotesSettings = {
  accountId: 'account-local',
  accountName: 'On My Mac',
  folderId: 'folder-test',
  folderName: 'SP2O Tests'
};
const notesBackground = loadBackground();
notesBackground.stored.storageProvider = 'apple-notes';
notesBackground.stored.appleNotesSettings = appleNotesSettings;
const notesPost = {
  content: '<img src=x onerror=alert(1)> 中文內容',
  platform: 'x',
  url: 'https://x.com/author/status/123456',
  timestamp: '2026-07-18T11:00:00+08:00',
  draftSessionId: 'notes-session-1',
  quoted: { content: '<script>quoted()</script>' },
  media: [{ url: 'https://pbs.twimg.com/media/good.jpg', alt: '<b>不可信 alt</b>' }]
};
await notesBackground.context.handleSaveDraft(notesPost, null);
assert.equal(notesBackground.stored.draftSnapshot_x.data.content, notesPost.content);
assert.equal(notesBackground.stored.draftStatus_x.ref, null, 'Apple Notes 草稿只存在 chrome.storage.local');
await notesBackground.context.handlePublishDraft(notesPost, null);
const notesUpsert = notesBackground.nativeMessages.find(message => message.action === 'notesUpsert');
assert.ok(notesUpsert, 'Apple Notes adapter 必須透過 Native Helper 寫入');
assert.match(notesUpsert.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(notesUpsert.html, /<script>/);
assert.match(notesUpsert.html, /&lt;script&gt;quoted\(\)&lt;\/script&gt;/);
assert.equal(notesUpsert.attachments[0].name, 'image-01.jpg');
assert.equal(notesBackground.stored.recentSaves[0].ref.provider, 'apple-notes');
assert.equal('draftSnapshot_x' in notesBackground.stored, false, '目的地接受正式貼文後才清除 Notes 草稿快照');
await notesBackground.context.handleSavePost({ ...notesPost, content: '遲到 API 修正內容' }, null);
const correctedNotesUpsert = notesBackground.nativeMessages
  .filter(message => message.action === 'notesUpsert').at(-1);
assert.equal(correctedNotesUpsert.noteId, 'note-1', '同 source 的遲到修正要更新原備忘錄，不得重複建立');
assert.match(correctedNotesUpsert.html, /遲到 API 修正內容/);
const notesRecentRef = notesBackground.stored.recentSaves[0].ref;
assert.deepEqual(
  JSON.parse(JSON.stringify(await notesBackground.context.openStorageActivity(notesRecentRef))),
  { ok: true }
);
assert.equal(notesBackground.nativeMessages.at(-1).action, 'notesShow');
await notesBackground.context.deleteVaultActivity({ kind: 'recent', ref: notesRecentRef });
assert.equal(notesBackground.nativeMessages.at(-1).action, 'notesDelete');
assert.deepEqual(JSON.parse(JSON.stringify(notesBackground.stored.recentSaves)), []);

// Notes 暫時無法啟動時，queue 必須綁原 provider；切換目的地後仍回原 Notes 資料夾補存。
const queuedNotesBackground = loadBackground();
queuedNotesBackground.stored.storageProvider = 'apple-notes';
queuedNotesBackground.stored.appleNotesSettings = appleNotesSettings;
queuedNotesBackground.setNativeMode('notes-unavailable');
const queuedNotesPost = { ...notesPost, content: '等待 Apple 備忘錄補存', draftSessionId: 'notes-session-queue' };
await queuedNotesBackground.context.handleSaveDraft(queuedNotesPost, null);
await queuedNotesBackground.context.handlePublishDraft(queuedNotesPost, null);
assert.equal(queuedNotesBackground.stored.offlineQueue[0].provider, 'apple-notes');
assert.equal('draftSnapshot_x' in queuedNotesBackground.stored, true, 'Notes 尚未接受貼文時要保留完整草稿');
queuedNotesBackground.stored.storageProvider = 'markdown-folder';
queuedNotesBackground.setNativeMode('ok');
await queuedNotesBackground.context.retryOfflineQueue();
assert.equal(queuedNotesBackground.stored.offlineQueue.length, 0);
assert.equal(
  queuedNotesBackground.nativeMessages.filter(message => message.action === 'notesUpsert').at(-1).action,
  'notesUpsert',
  '切換目的地後仍須用 queue 原本的 Apple Notes provider'
);
assert.equal('draftSnapshot_x' in queuedNotesBackground.stored, false);

// 三日內自回覆要讀回目前 HTML 後追加，保留使用者手改內容。
const notesAppendBackground = loadBackground();
notesAppendBackground.stored.storageProvider = 'apple-notes';
notesAppendBackground.stored.appleNotesSettings = appleNotesSettings;
const notesRootUrl = 'https://x.com/author/status/2083453394208067681';
const notesReplyUrl = 'https://x.com/author/status/2083584260859142583';
const notesRootKey = notesAppendBackground.context.postIdentity(notesRootUrl);
const notesRootRef = {
  provider: 'apple-notes',
  noteId: 'note-root',
  title: '手改過的母筆記',
  externalKey: notesRootKey
};
notesAppendBackground.setNativeNote({
  noteId: 'note-root',
  title: '手改過的母筆記',
  externalKey: notesRootKey,
  html: `<div data-sp2o-key="${notesRootKey}"><p>使用者手改段落</p></div>`
});
notesAppendBackground.stored.recentThreadContexts = [{
  filename: '手改過的母筆記',
  ref: notesRootRef,
  platform: 'x',
  url: notesRootUrl,
  mergeMode: 'notes-html',
  mergeSegments: [{ content: '母貼文', url: notesRootUrl, timestamp: '2026-08-01T15:22:00+08:00' }],
  rootTimestamp: '2026-08-01T15:22:00+08:00',
  mergeUrls: [notesRootUrl],
  recordedAt: '2026-08-01T15:22:00+08:00'
}];
await notesAppendBackground.context.handleSavePost({
  content: '追加 <unsafe> 回覆',
  platform: 'x',
  url: notesReplyUrl,
  replyTo: notesRootUrl,
  timestamp: '2026-08-01T23:59:00+08:00',
  media: []
}, null);
const appendedNote = notesAppendBackground.getNativeNote('note-root');
assert.match(appendedNote.html, /使用者手改段落/);
assert.match(appendedNote.html, /追加 &lt;unsafe&gt; 回覆/);

// 母筆記被鎖定時不得丟掉回覆，必須另建並標示母筆記標題。
notesAppendBackground.setNativeNote({ ...appendedNote, noteId: 'note-root', locked: true });
await notesAppendBackground.context.handleSavePost({
  content: '鎖定後仍要保存',
  platform: 'x',
  url: 'https://x.com/author/status/2083585260859142583',
  replyTo: notesRootUrl,
  timestamp: '2026-08-02T00:01:00+08:00',
  media: []
}, null);
const separateNotesUpsert = notesAppendBackground.nativeMessages
  .filter(message => message.action === 'notesUpsert').at(-1);
assert.equal(separateNotesUpsert.noteId, '');
assert.match(separateNotesUpsert.html, /母筆記：<\/strong>手改過的母筆記/);
assert.equal(notesAppendBackground.stored.recentThreadContexts[0].ref.noteId, 'note-2');
assert.deepEqual(
  JSON.parse(JSON.stringify(notesAppendBackground.stored.recentThreadContexts[0].mergeUrls)),
  ['https://x.com/author/status/2083585260859142583']
);

const draftMarkdown = background.context.generateDraftMarkdown({
  content: 'Threads 第一則\n\n---\n\nThreads 第二則',
  thread: ['Threads 第一則', 'Threads 第二則'],
  platform: 'threads',
  timestamp: '2026-07-18T11:00:00+08:00'
});
assert.deepEqual(parseYamlFrontmatter(draftMarkdown), {
  title: 'Threads 草稿',
  updated: '2026-07-18 11:00',
  platform: 'Threads',
  source: 'threads',
  status: 'draft',
  thread_count: 2,
  tags: ['社群草稿', 'Threads', '串文']
});
assert.match(draftMarkdown, /> \[!warning\] 未發佈草稿/);
assert.match(draftMarkdown, /## 串文草稿\n\n### 1 \/ 2\n\n```\nThreads 第一則\n```/);
assert.match(draftMarkdown, /### 2 \/ 2\n\n```\nThreads 第二則\n```/);

const formattedThreadMarkdown = background.context.generateMarkdown({
  content: '串文第一則\n\n---\n\n串文第二則',
  thread: ['串文第一則', '串文第二則'],
  platform: 'x',
  url: 'https://x.com/author/status/123456?source=test',
  timestamp: '2026-07-18T11:00:00+08:00',
  replyTo: 'https://x.com/replied/status/10',
  quoted: {
    author: 'quoted',
    authorName: 'Quoted "Name"',
    content: '引用第一行\n引用第二行',
    url: 'https://x.com/quoted/status/20'
  }
});
assert.deepEqual(parseYamlFrontmatter(formattedThreadMarkdown), {
  title: '串文第一則',
  created: '2026-07-18 11:00',
  platform: 'Twitter/X',
  source: 'x',
  source_url: 'https://x.com/author/status/123456?source=test',
  status: 'published',
  post_type: 'thread',
  thread_count: 2,
  reply_to: 'https://x.com/replied/status/10',
  quoted_from: '@quoted',
  quoted_author_name: 'Quoted "Name"',
  quoted_url: 'https://x.com/quoted/status/20',
  tags: ['社群貼文', 'Twitter/X', '串文', '引用'],
  summary: ''
});
assert.match(formattedThreadMarkdown, /> \[!info\] 貼文資訊/);
assert.match(formattedThreadMarkdown, /> \*\*類型\*\*：串文/);
assert.match(formattedThreadMarkdown, /## 串文內容\n\n### 1 \/ 2\n\n```\n串文第一則\n```/);
assert.match(formattedThreadMarkdown, /### 2 \/ 2\n\n```\n串文第二則\n```/);
assert.match(formattedThreadMarkdown, /> \[!quote\] 引用貼文/);

// F2: 引用內容（他人撰寫）的 Markdown/HTML 注入必須逸出，不得渲染成遠端圖片或 Obsidian 嵌入
const maliciousQuoteMarkdown = background.context.generateMarkdown({
  content: '我的貼文',
  platform: 'x',
  url: 'https://x.com/author/status/1',
  timestamp: '2026-07-18T11:00:00+08:00',
  quoted: {
    author: 'attacker',
    authorName: 'attacker',
    content: '![x](https://evil.example/track.png)\n<img src="https://evil.example/2.png">\n![[secret.png]]',
    url: 'https://x.com/attacker/status/2'
  }
});
assert.doesNotMatch(maliciousQuoteMarkdown, /<img/i);
assert.doesNotMatch(maliciousQuoteMarkdown, /!\[x\]\(https:\/\/evil/);
assert.doesNotMatch(maliciousQuoteMarkdown, /!\[\[secret/);

const singlePostMarkdown = background.context.generateMarkdown(postData);
assert.match(singlePostMarkdown, /## 貼文內容\n\n```\n圖片同步測試\n```/);
assert.equal(parseYamlFrontmatter(singlePostMarkdown).post_type, 'post');
assert.deepEqual(
  JSON.parse(JSON.stringify(background.context.publishedPostLocation(
    postData,
    '個人創作/社群推文'
  ))),
  {
    filename: '2026-07-18_1100_圖片同步測試.md',
    fullPath: '個人創作/社群推文/2026-07-18_1100_圖片同步測試.md',
    category: { type: 'post', label: '發文', folder: '發文' }
  }
);

const categoryCases = [
  {
    expected: 'reply',
    data: { ...postData, replyTo: 'https://x.com/someone/status/1' }
  },
  {
    expected: 'quote',
    data: {
      ...postData,
      quoted: { author: 'other', authorName: 'Other', content: '引用', url: 'https://x.com/other/status/2' }
    }
  },
  {
    expected: 'thread',
    data: { ...postData, replyTo: 'https://x.com/author/status/3' }
  },
  {
    expected: 'thread',
    data: { ...postData, thread: ['第一則', '第二則'] }
  }
];
for (const item of categoryCases) {
  assert.equal(background.context.classifyPost(item.data).type, item.expected);
}
assert.equal(background.context.classifyPost({ ...postData, platform: 'threads' }), null);

const replyMarkdown = background.context.generateMarkdown({
  ...postData,
  replyTo: 'https://x.com/someone/status/1'
});
assert.deepEqual(parseYamlFrontmatter(replyMarkdown).tags, ['社群貼文', 'Twitter/X', '回覆']);
const quoteReplyMarkdown = background.context.generateMarkdown({
  ...postData,
  replyTo: 'https://x.com/someone/status/1',
  quoted: { author: 'other', authorName: 'Other', content: '引用', url: 'https://x.com/other/status/2' }
});
assert.deepEqual(
  parseYamlFrontmatter(quoteReplyMarkdown).tags,
  ['社群貼文', 'Twitter/X', '引用', '回覆']
);

const classifiedSaveBackground = loadBackground();
classifiedSaveBackground.stored.storageProvider = 'markdown-folder';
classifiedSaveBackground.stored.basePath = '個人創作/社群推文';
classifiedSaveBackground.stored.mediaPath = '附件/順筆';
await classifiedSaveBackground.context.handleSavePost({
  ...postData,
  media: [],
  replyTo: 'https://x.com/someone/status/1'
}, null);
const classifiedWrite = classifiedSaveBackground.nativeMessages
  .filter(message => message.action === 'write')
  .at(-1);
assert.equal(
  classifiedWrite.path,
  '個人創作/社群推文/2026-07-18_1100_圖片同步測試.md'
);
assert.equal(parseYamlFrontmatter(classifiedWrite.data).post_type, 'reply');

// 原文若含三個反引號，外層 fence 必須自動加長，避免提早結束 code block。
const nestedFenceMarkdown = background.context.generateMarkdown({
  ...postData,
  content: '貼文內有 code fence\n```\nconst ok = true;\n```'
});
assert.match(
  nestedFenceMarkdown,
  /## 貼文內容\n\n````\n貼文內有 code fence\n```\nconst ok = true;\n```\n````/
);

// 用實際 Native Host 寫入隔離 Vault，再從磁碟讀回並解析 YAML。
const markdownVaultRoot = mkdtempSync(join(tmpdir(), 'sp2o-markdown-test-'));
try {
  const vaultPath = join(markdownVaultRoot, 'Markdown Vault');
  const configDirectory = join(markdownVaultRoot, 'config');
  mkdirSync(join(vaultPath, '.obsidian'), { recursive: true });
  assert.equal(sendNativeHostMessage({ action: 'configure', vaultPath }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/_草稿_Threads.md',
    encoding: 'utf8',
    data: draftMarkdown
  }, configDirectory).ok, true);
  assert.equal(sendNativeHostMessage({
    action: 'write',
    path: '個人創作/社群推文/串文測試.md',
    encoding: 'utf8',
    data: formattedThreadMarkdown
  }, configDirectory).ok, true);
  const writtenDraft = readFileSync(
    join(vaultPath, '個人創作', '社群推文', '_草稿_Threads.md'),
    'utf8'
  );
  const writtenPost = readFileSync(
    join(vaultPath, '個人創作', '社群推文', '串文測試.md'),
    'utf8'
  );
  assert.equal(writtenDraft, draftMarkdown);
  assert.equal(writtenPost, formattedThreadMarkdown);
  assert.equal(parseYamlFrontmatter(writtenDraft).status, 'draft');
  assert.equal(parseYamlFrontmatter(writtenPost).thread_count, 2);
} finally {
  rmSync(markdownVaultRoot, { recursive: true, force: true });
}

const result = await background.context.savePostBundle(postData, path, filename, settings);
assert.deepEqual(JSON.parse(JSON.stringify(result)), { savedMedia: 1, failedMedia: 1 });
assert.equal(background.requests.length, 2);
assert.equal(background.requests[0].init.headers['Content-Type'], 'image/jpeg');
assert.match(
  decodeURIComponent(background.requests[0].url),
  /附件\/順筆\/2026-07-18_1100_圖片同步測試\/image-01\.jpg$/
);
const markdown = background.requests[1].init.body;
assert.match(
  markdown,
  /!\[成功圖片\]\(<\.\.\/\.\.\/附件\/順筆\/2026-07-18_1100_圖片同步測試\/image-01\.jpg>\)/
);
assert.match(markdown, /!\[失敗圖片\]\(<https:\/\/pbs\.twimg\.com\/media\/missing\.jpg>\)/);

const threadsConfigureFilename = '2026-07-18_1110_現行發文端點圖片.md';
const threadsConfigurePath = `個人創作/社群推文/${threadsConfigureFilename}`;
const threadsConfigureResult = await background.context.savePostBundle({
  content: parsedThreadsConfigure.text,
  platform: 'threads',
  url: parsedThreadsConfigure.url,
  timestamp: '2026-07-18T11:10:00+08:00',
  media: parsedThreadsConfigure.media
}, threadsConfigurePath, threadsConfigureFilename, settings);
assert.deepEqual(JSON.parse(JSON.stringify(threadsConfigureResult)), { savedMedia: 1, failedMedia: 0 });
assert.match(
  decodeURIComponent(background.requests[2].url),
  /附件\/順筆\/2026-07-18_1110_現行發文端點圖片\/image-01\.webp$/
);
assert.match(background.requests[3].init.body, /!\[現行 Threads 圖片\]/);

const imageOnlyFilename = background.context.generateFilename({
  content: '',
  timestamp: '2026-07-18T11:00:00+08:00'
});
assert.equal(imageOnlyFilename, '2026-07-18_1100_圖片貼文.md');
// 內容全是不合法檔名字元時，摘要退回 fallback 而非空字串
assert.equal(
  background.context.generateFilename({ content: '???', timestamp: '2026-07-18T11:00:00+08:00' }),
  '2026-07-18_1100_貼文.md'
);
assert.equal(background.context.platformDisplayName('x', true), 'Twitter');
assert.equal(background.context.platformDisplayName('x'), 'Twitter/X');
assert.equal(background.context.platformDisplayName('threads'), 'Threads');
assert.equal(background.context.resolveStorageMode({}), 'native');
assert.equal(background.context.resolveStorageMode({ storageProvider: 'obsidian-rest' }), 'rest');
assert.equal(background.context.resolveStorageMode({ storageProvider: 'apple-notes' }), 'apple-notes');
assert.equal(background.context.createContentPreview('  第一行\n  第二行  '), '第一行 第二行');
const emojiPreview = background.context.createContentPreview('😀'.repeat(161));
assert.equal(Array.from(emojiPreview).length, 161);
assert.equal(emojiPreview.endsWith('…'), true);

const nativeBackground = loadBackground();
await new Promise(resolve => setImmediate(resolve));
const nativeSettings = {
  storageProvider: 'markdown-folder',
  basePath: '個人創作/社群推文',
  mediaPath: '附件/順筆'
};
const nativeMessagesBeforeBundle = nativeBackground.nativeMessages.length;
const nativeResult = await nativeBackground.context.savePostBundle(
  { ...postData, media: [{ url: 'https://pbs.twimg.com/media/good.jpg', alt: 'Helper 寫入圖片' }] },
  path,
  filename,
  nativeSettings
);
assert.deepEqual(JSON.parse(JSON.stringify(nativeResult)), { savedMedia: 1, failedMedia: 0 });
const nativeWrites = nativeBackground.nativeMessages.filter(message => message.action === 'write');
assert.equal(nativeWrites.length, 2);
assert.match(
  nativeWrites[0].path,
  /附件\/順筆\/2026-07-18_1100_圖片同步測試\/image-01\.jpg$/
);
assert.equal(nativeWrites[0].encoding, 'base64');
assert.equal(nativeWrites[0].data, '/9j/');
assert.equal(nativeWrites[1].path, path);
assert.equal(nativeWrites[1].encoding, 'utf8');
assert.match(nativeWrites[1].data, /!\[Helper 寫入圖片\]/);
// 發文流程不再觸發空資料夾清理（剛寫完必非空；清理交給刪除流程與定期 alarm）
assert.equal(
  nativeBackground.nativeMessages.slice(nativeMessagesBeforeBundle)
    .some(message => message.action === 'cleanEmptyMediaFolders'),
  false
);

const twentyMediaBackground = loadBackground();
await new Promise(resolve => setImmediate(resolve));
const twentyMediaStart = twentyMediaBackground.nativeMessages.length;
const twentyMediaResult = await twentyMediaBackground.context.savePostBundle(
  {
    ...postData,
    media: Array.from({ length: 20 }, (_, index) => ({
      url: `https://pbs.twimg.com/media/good-${index}.jpg`,
      alt: `圖片 ${index + 1}`
    }))
  },
  path,
  filename,
  nativeSettings
);
assert.deepEqual(JSON.parse(JSON.stringify(twentyMediaResult)), { savedMedia: 20, failedMedia: 0 });
assert.equal(
  twentyMediaBackground.nativeMessages.slice(twentyMediaStart)
    .filter(message => message.action === 'write').length,
  21,
  '20 張圖片要先各寫一個檔案，再寫 Markdown'
);

nativeBackground.stored.storageProvider = 'markdown-folder';
nativeBackground.stored.basePath = '個人創作/社群推文';
await nativeBackground.context.handleSaveDraft({
  content: 'Helper 暫存草稿',
  platform: 'x',
  timestamp: '2026-07-18T11:01:00+08:00'
}, null);
assert.equal(nativeBackground.nativeMessages.at(-1).path, '個人創作/社群推文/_草稿_Twitter.md');
assert.match(nativeBackground.nativeMessages.at(-1).data, /Helper 暫存草稿/);
assert.equal(nativeBackground.stored.draftStatus_x.preview, 'Helper 暫存草稿');

await nativeBackground.context.deleteVaultFile('個人創作/社群推文/_草稿_Twitter.md', nativeSettings);
assert.deepEqual(JSON.parse(JSON.stringify(nativeBackground.nativeMessages.at(-1))), {
  action: 'remove',
  path: '個人創作/社群推文/_草稿_Twitter.md'
});

const clearBackground = loadBackground();
clearBackground.stored.storageProvider = 'markdown-folder';
clearBackground.stored.basePath = '個人創作/社群推文';
clearBackground.stored.draftStatus_x = {
  path: '個人創作/社群推文/_草稿_Twitter.md'
};
clearBackground.stored.draftStatus_threads = {
  path: '個人創作/社群推文/_草稿_Threads.md'
};
const clearResult = await clearBackground.context.clearAutoDrafts();
assert.deepEqual(JSON.parse(JSON.stringify(clearResult)), { ok: true, cleared: 2 });
assert.equal('draftStatus_x' in clearBackground.stored, false);
assert.equal('draftStatus_threads' in clearBackground.stored, false);
assert.deepEqual(
  clearBackground.nativeMessages.filter(message => message.action === 'remove').map(message => message.path),
  ['個人創作/社群推文/_草稿_Twitter.md', '個人創作/社群推文/_草稿_Threads.md']
);

clearBackground.stored.draftStatus_x = {
  path: '個人創作/社群推文/_草稿_Twitter.md'
};
clearBackground.setNativeMode('unavailable');
const failedClear = await clearBackground.context.clearAutoDrafts();
assert.equal(failedClear.ok, false);
assert.equal(failedClear.cleared, 0);
assert.equal('draftStatus_x' in clearBackground.stored, true);

const restClearBackground = loadBackground();
restClearBackground.stored.storageProvider = 'obsidian-rest';
restClearBackground.stored.apiKey = 'test-key';
restClearBackground.stored.port = 27123;
restClearBackground.stored.draftStatus_threads = {
  path: '個人創作/社群推文/_草稿_Threads.md'
};
const restClearResult = await restClearBackground.context.clearAutoDrafts();
assert.deepEqual(JSON.parse(JSON.stringify(restClearResult)), { ok: true, cleared: 1 });
assert.equal(restClearBackground.requests.at(-1).init.method, 'DELETE');
assert.match(
  decodeURIComponent(restClearBackground.requests.at(-1).url),
  /個人創作\/社群推文\/_草稿_Threads\.md$/
);

const nativeSyncBackground = loadBackground();
nativeSyncBackground.stored.storageProvider = 'markdown-folder';
nativeSyncBackground.stored.mediaPath = '附件/順筆';
nativeSyncBackground.stored.draftStatus_x = {
  path: '個人創作/社群推文/_草稿_Twitter.md'
};
nativeSyncBackground.stored.recentSaves = [{
  filename,
  path,
  platform: 'x'
}];
nativeSyncBackground.stored.recentThreadContexts = [{ path, platform: 'x' }];
nativeSyncBackground.setNativeMode('missing');
const nativeSyncResult = await nativeSyncBackground.context.syncVaultActivity();
assert.deepEqual(JSON.parse(JSON.stringify(nativeSyncResult)), {
  ok: true,
  removedDrafts: 1,
  removedRecent: 1
});
assert.equal('draftStatus_x' in nativeSyncBackground.stored, false);
assert.deepEqual(JSON.parse(JSON.stringify(nativeSyncBackground.stored.recentSaves)), []);
assert.deepEqual(JSON.parse(JSON.stringify(nativeSyncBackground.stored.recentThreadContexts)), []);
assert.equal(
  nativeSyncBackground.nativeMessages.some(message => message.action === 'cleanEmptyMediaFolders'),
  true
);

const fastNotesSyncBackground = loadBackground();
fastNotesSyncBackground.stored.storageProvider = 'apple-notes';
fastNotesSyncBackground.stored.appleNotesSettings = appleNotesSettings;
fastNotesSyncBackground.stored.recentSaves = [{
  filename: 'Apple 備忘錄測試',
  platform: 'x',
  ref: {
    provider: 'apple-notes',
    noteId: 'note-fast-sync',
    title: 'Apple 備忘錄測試',
    externalKey: 'x:fast-sync'
  }
}];
fastNotesSyncBackground.setNativeNote({
  noteId: 'note-fast-sync',
  title: 'Apple 備忘錄測試',
  externalKey: 'x:fast-sync',
  html: '<div data-sp2o-key="x:fast-sync">測試</div>'
});
const fastNotesSyncResult = await fastNotesSyncBackground.context.syncVaultActivity({ skipAppleNotes: true });
assert.deepEqual(JSON.parse(JSON.stringify(fastNotesSyncResult)), {
  ok: true,
  removedDrafts: 0,
  removedRecent: 0
});
assert.equal(
  fastNotesSyncBackground.nativeMessages.some(message => message.action === 'notesExists'),
  false,
  'Popup 自動同步不得為每筆 Apple 備忘錄各啟動一次 AppleScript'
);
assert.equal(fastNotesSyncBackground.stored.recentSaves.length, 1);

const offlineSyncBackground = loadBackground();
offlineSyncBackground.stored.storageProvider = 'markdown-folder';
offlineSyncBackground.stored.draftStatus_threads = {
  path: '個人創作/社群推文/_草稿_Threads.md'
};
offlineSyncBackground.setNativeMode('unavailable');
await assert.rejects(() => offlineSyncBackground.context.syncVaultActivity());
assert.equal('draftStatus_threads' in offlineSyncBackground.stored, true);

const restSyncBackground = loadBackground();
restSyncBackground.stored.storageProvider = 'obsidian-rest';
restSyncBackground.stored.apiKey = 'test-key';
restSyncBackground.stored.port = 27123;
restSyncBackground.stored.recentSaves = [{ filename, path, platform: 'x' }];
restSyncBackground.setLocalMode('missing');
const restSyncResult = await restSyncBackground.context.syncVaultActivity();
assert.deepEqual(JSON.parse(JSON.stringify(restSyncResult)), {
  ok: true,
  removedDrafts: 0,
  removedRecent: 1
});
assert.deepEqual(JSON.parse(JSON.stringify(restSyncBackground.stored.recentSaves)), []);
assert.equal(restSyncBackground.requests.at(-1).init.method, 'GET');

const deleteActivityBackground = loadBackground();
deleteActivityBackground.stored.storageProvider = 'markdown-folder';
deleteActivityBackground.stored.mediaPath = '附件/順筆';
deleteActivityBackground.stored.recentSaves = [{ filename, path, platform: 'x' }];
deleteActivityBackground.stored.recentThreadContexts = [{ path, platform: 'x' }];
const deleteActivityResult = await deleteActivityBackground.context.deleteVaultActivity({
  kind: 'recent',
  ref: deleteActivityBackground.stored.recentSaves[0].ref
});
assert.deepEqual(JSON.parse(JSON.stringify(deleteActivityResult)), { ok: true });
assert.deepEqual(JSON.parse(JSON.stringify(deleteActivityBackground.stored.recentSaves)), []);
assert.deepEqual(JSON.parse(JSON.stringify(deleteActivityBackground.stored.recentThreadContexts)), []);
assert.deepEqual(JSON.parse(JSON.stringify(
  deleteActivityBackground.nativeMessages.find(message => message.action === 'remove')
)), { action: 'remove', path });

await assert.rejects(
  () => deleteActivityBackground.context.deleteVaultActivity({
    kind: 'recent',
    ref: {
      provider: 'markdown-folder',
      path: '個人創作/社群推文/未受追蹤.md',
      title: '未受追蹤.md',
      externalKey: 'missing'
    }
  }),
  /找不到要刪除的貼文/
);

const restDeleteActivityBackground = loadBackground();
restDeleteActivityBackground.stored.storageProvider = 'obsidian-rest';
restDeleteActivityBackground.stored.apiKey = 'test-key';
restDeleteActivityBackground.stored.port = 27123;
restDeleteActivityBackground.stored.recentSaves = [{ filename, path, platform: 'x' }];
await restDeleteActivityBackground.context.deleteVaultActivity({
  kind: 'recent',
  ref: restDeleteActivityBackground.stored.recentSaves[0].ref
});
assert.deepEqual(JSON.parse(JSON.stringify(restDeleteActivityBackground.stored.recentSaves)), []);
assert.equal(restDeleteActivityBackground.requests.at(-1).init.method, 'DELETE');

nativeBackground.setNativeMode('unavailable');
await nativeBackground.context.saveWithQueueFallback(
  path,
  filename,
  { ...postData, media: [] },
  nativeSettings,
  null
);
assert.equal(nativeBackground.stored.offlineQueue.length, 1);
assert.equal(nativeBackground.stored.offlineQueue[0].data.content, postData.content);
assert.equal('apiKey' in nativeBackground.stored.offlineQueue[0], false);

nativeBackground.stored.storageProvider = 'markdown-folder';
nativeBackground.stored.mediaPath = '附件/順筆';
nativeBackground.setNativeMode('ok');
await nativeBackground.context.retryOfflineQueue();
assert.deepEqual(JSON.parse(JSON.stringify(nativeBackground.stored.offlineQueue)), []);
assert.equal(nativeBackground.stored.recentSaves[0].filename, filename);
assert.equal(nativeBackground.stored.recentSaves[0].preview, '圖片同步測試');

background.stored.storageProvider = 'obsidian-rest';
background.setLocalMode('offline');
await background.context.saveWithQueueFallback(
  path,
  filename,
  { ...postData, media: [{ url: 'https://pbs.twimg.com/media/good.jpg', alt: '離線圖片' }] },
  settings,
  null
);
assert.equal(background.stored.offlineQueue.length, 1);
assert.equal(background.stored.offlineQueue[0].data.media[0].url, 'https://pbs.twimg.com/media/good.jpg');
assert.equal('markdown' in background.stored.offlineQueue[0], false);

background.stored.apiKey = 'test-key';
background.stored.port = 27123;
background.stored.mediaPath = '附件/順筆';
background.setLocalMode('ok');
await background.context.retryOfflineQueue();
assert.deepEqual(JSON.parse(JSON.stringify(background.stored.offlineQueue)), []);
assert.equal(background.stored.recentSaves[0].filename, filename);
assert.equal(background.stored.recentSaves[0].preview, '圖片同步測試');
assert.match(
  decodeURIComponent(background.requests.at(-2).url),
  /附件\/順筆\/2026-07-18_1100_圖片同步測試\/image-01\.jpg$/
);

// 發佈失敗（REST 回 401，非連線錯誤）：不進離線佇列，且草稿檔與 draftStatus 都保留
const failedPublishBackground = loadBackground();
failedPublishBackground.stored.storageProvider = 'obsidian-rest';
failedPublishBackground.stored.apiKey = 'test-key';
failedPublishBackground.stored.port = 27123;
failedPublishBackground.stored.draftStatus_x = {
  path: '個人創作/社群推文/_草稿_Twitter.md'
};
failedPublishBackground.setLocalMode('unauthorized');
await failedPublishBackground.context.handlePublishDraft({
  content: '發佈失敗測試',
  platform: 'x',
  url: 'https://x.com/author/status/9',
  timestamp: '2026-07-18T11:05:00+08:00'
}, null);
assert.equal('draftStatus_x' in failedPublishBackground.stored, true);
assert.equal((failedPublishBackground.stored.offlineQueue || []).length, 0);
assert.equal(
  failedPublishBackground.requests.some(request => request.init.method === 'DELETE'),
  false
);

// Native Host 回報永久性錯誤（如 Vault 未設定）：向上拋出、不得進離線佇列
const rejectedNativeBackground = loadBackground();
rejectedNativeBackground.setNativeMode('rejected');
await assert.rejects(
  () => rejectedNativeBackground.context.saveWithQueueFallback(
    path,
    filename,
    { ...postData, media: [] },
    nativeSettings,
    null
  ),
  /Vault is not configured/
);
assert.equal((rejectedNativeBackground.stored.offlineQueue || []).length, 0);

// recentSaves 依 StorageRef 去重：同一份內容重送／修正只保留一筆。
const dedupBackground = loadBackground();
const dedupRef = { provider: 'markdown-folder', path, title: filename, externalKey: postData.url };
await dedupBackground.context.recordRecentSave({ filename, ref: dedupRef, platform: 'x' });
await dedupBackground.context.recordRecentSave({ filename, ref: dedupRef, platform: 'x' });
assert.equal(dedupBackground.stored.recentSaves.length, 1);
assert.equal(dedupBackground.stored.recentSaves[0].ref.path, path);

// 升級前已存在的母文沒有 recentThreadContexts 時，仍要依 source_url 讀回 Vault 原文追加。
// 使用實際回報的兩個 X status ID，兩者相差約 8 小時 40 分，確定落在 72 小時內。
const legacyAppendBackground = loadBackground();
legacyAppendBackground.stored.storageProvider = 'markdown-folder';
legacyAppendBackground.stored.basePath = '個人創作/社群推文';
legacyAppendBackground.stored.mediaPath = '附件/順筆';
const reportedRootUrl = 'https://x.com/lokunlim/status/2083453394208067681';
const reportedReplyUrl = 'https://x.com/lokunlim/status/2083584260859142583';
const legacyRootPath = '個人創作/社群推文/2026-08-01_1522_韓國父權.md';
const legacyRootData = {
  content: '韓國父權會如此嚴重的本質應該也是來自於「不懂得尊重」吧？',
  platform: 'x',
  url: reportedRootUrl,
  timestamp: '2026-08-01T15:22:52+08:00',
  media: [],
  quoted: {
    author: 'Hellomeow0',
    authorName: '할로묘묘',
    url: 'https://x.com/Hellomeow0/status/2083167913071333787',
    content: '既有引用內容必須保留'
  }
};
const legacyRootMarkdown = legacyAppendBackground.context.generateMarkdown(legacyRootData, [{
  path: '../../附件/順筆/2026-08-01_1522_韓國父權/image-01.jpg',
  alt: '母文圖片'
}]);
legacyAppendBackground.setNativeFile(legacyRootPath, legacyRootMarkdown);
legacyAppendBackground.stored.recentSaves = [{
  filename: '2026-08-01_1522_韓國父權.md',
  path: legacyRootPath,
  platform: 'x',
  url: reportedRootUrl,
  savedAt: '2026-08-01T07:22:53.000Z'
}];
await legacyAppendBackground.context.handleSavePost({
  content: '測試合併推文',
  platform: 'x',
  url: reportedReplyUrl,
  replyTo: reportedRootUrl,
  timestamp: '2026-08-02T00:02:53+08:00',
  media: [{ url: 'https://pbs.twimg.com/media/good-reply.jpg', alt: '回文圖片' }]
}, null);
const legacyAppendMessages = legacyAppendBackground.nativeMessages;
assert.ok(legacyAppendMessages.some(message => message.action === 'read' && message.path === legacyRootPath));
const legacyAppendWrite = legacyAppendMessages.filter(message => message.action === 'write').at(-1);
assert.equal(legacyAppendWrite.path, legacyRootPath);
const legacyAppendYaml = parseYamlFrontmatter(legacyAppendWrite.data);
assert.equal(legacyAppendYaml.source_url, reportedRootUrl);
assert.equal(legacyAppendYaml.post_type, 'thread');
assert.equal(legacyAppendYaml.thread_count, 2);
assert.deepEqual(legacyAppendYaml.tags, ['社群貼文', 'Twitter/X', '引用', '串文']);
assert.match(legacyAppendWrite.data, /### 1 \/ 2[\s\S]*韓國父權會如此嚴重/);
assert.match(legacyAppendWrite.data, /### 2 \/ 2[\s\S]*測試合併推文/);
assert.match(legacyAppendWrite.data, /image-01\.jpg/);
assert.match(legacyAppendWrite.data, /image-02\.jpg/);
assert.match(legacyAppendWrite.data, /> \[!quote\] 引用貼文[\s\S]*既有引用內容必須保留/);
assert.ok(legacyAppendMessages.some(message => (
  message.action === 'write' && /image-02\.jpg$/.test(message.path)
)));
assert.equal(legacyAppendBackground.stored.recentThreadContexts[0].mergeMode, 'markdown');
assert.equal(legacyAppendBackground.stored.recentSaves[0].url, reportedRootUrl);
assert.deepEqual(
  JSON.parse(JSON.stringify(legacyAppendBackground.stored.recentThreadContexts[0].mergeUrls)),
  [reportedRootUrl, reportedReplyUrl]
);

// 母筆記在 Obsidian 被手動改掉「## 貼文內容」標題後仍要合併：source_url 已確認身分，
// 找不到內容區塊就接在檔尾，寧可格式不完美，也不能讓回覆消失或另開新檔。
const editedRootBackground = loadBackground();
editedRootBackground.stored.storageProvider = 'markdown-folder';
editedRootBackground.stored.basePath = '個人創作/社群推文';
editedRootBackground.stored.mediaPath = '附件/順筆';
const editedRootPath = '個人創作/社群推文/2026-08-01_1522_手改過的母文.md';
const editedRootMarkdown = editedRootBackground.context
  .generateMarkdown({ ...legacyRootData, quoted: null }, [])
  .replace('## 貼文內容', '## 我自己改的標題');
editedRootBackground.setNativeFile(editedRootPath, editedRootMarkdown);
editedRootBackground.stored.recentSaves = [{
  filename: '2026-08-01_1522_手改過的母文.md',
  path: editedRootPath,
  platform: 'x',
  url: reportedRootUrl,
  savedAt: '2026-08-01T07:22:53.000Z'
}];
await editedRootBackground.context.handleSavePost({
  content: '接在檔尾的回覆',
  platform: 'x',
  url: reportedReplyUrl,
  replyTo: reportedRootUrl,
  timestamp: '2026-08-02T00:02:53+08:00',
  media: []
}, null);
const editedRootWrite = editedRootBackground.nativeMessages
  .filter(message => message.action === 'write').at(-1);
assert.equal(editedRootWrite.path, editedRootPath, '標題被改掉仍要合併進同一檔，不得另存');
assert.match(editedRootWrite.data, /## 我自己改的標題[\s\S]*韓國父權會如此嚴重/);
assert.match(editedRootWrite.data, /### 2 \/ 2\n\n[\s\S]*接在檔尾的回覆/);
assert.equal(parseYamlFrontmatter(editedRootWrite.data).thread_count, 2);

// source_url 對不上就不是那篇母筆記，絕不能亂接：改另存新檔並標註母筆記。
const wrongAnchorBackground = loadBackground();
wrongAnchorBackground.stored.storageProvider = 'markdown-folder';
wrongAnchorBackground.stored.basePath = '個人創作/社群推文';
wrongAnchorBackground.stored.mediaPath = '附件/順筆';
const wrongAnchorPath = '個人創作/社群推文/2026-08-01_1522_換過內容的檔.md';
wrongAnchorBackground.setNativeFile(
  wrongAnchorPath,
  wrongAnchorBackground.context.generateMarkdown({
    content: '這個檔案已經被換成別則貼文了',
    platform: 'x',
    url: 'https://x.com/lokunlim/status/2000000000000000000',
    timestamp: '2026-08-01T15:22:52+08:00',
    media: []
  }, [])
);
wrongAnchorBackground.stored.recentSaves = [{
  filename: '2026-08-01_1522_換過內容的檔.md',
  path: wrongAnchorPath,
  platform: 'x',
  url: reportedRootUrl,
  savedAt: '2026-08-01T07:22:53.000Z'
}];
await wrongAnchorBackground.context.handleSavePost({
  content: '不該被亂接的回覆',
  platform: 'x',
  url: reportedReplyUrl,
  replyTo: reportedRootUrl,
  timestamp: '2026-08-02T00:02:53+08:00',
  media: []
}, null);
const wrongAnchorWrite = wrongAnchorBackground.nativeMessages
  .filter(message => message.action === 'write').at(-1);
assert.notEqual(wrongAnchorWrite.path, wrongAnchorPath, 'source_url 對不上不得覆寫該檔');
assert.match(wrongAnchorWrite.data, /不該被亂接的回覆/, '回覆內容仍必須寫進 Vault');
const wrongAnchorYaml = parseYamlFrontmatter(wrongAnchorWrite.data);
assert.equal(wrongAnchorYaml.thread_root, '[[2026-08-01_1522_換過內容的檔]]');
assert.equal(wrongAnchorYaml.reply_to, reportedRootUrl);
assert.match(wrongAnchorWrite.data, /> \[!info\] 接續 \[\[2026-08-01_1522_換過內容的檔\]\]/);
// 已用 markdown 模式合併過一次（context 累積了 mergeUrls 與母貼文的三日窗起點）之後，
// 母筆記才被改壞：第二則回覆要另存新檔，且新筆記不得沿用母筆記的合併身分與時間起點，
// 否則下一則回覆會依母筆記的 URL／時間再被導回那個已經接不了的檔。
const brokenRootBackground = loadBackground();
brokenRootBackground.stored.storageProvider = 'markdown-folder';
brokenRootBackground.stored.basePath = '個人創作/社群推文';
brokenRootBackground.stored.mediaPath = '附件/順筆';
const brokenRootPath = '個人創作/社群推文/2026-08-01_1522_待改壞的母文.md';
brokenRootBackground.setNativeFile(
  brokenRootPath,
  brokenRootBackground.context.generateMarkdown({ ...legacyRootData, quoted: null }, [])
);
brokenRootBackground.stored.recentSaves = [{
  filename: '2026-08-01_1522_待改壞的母文.md',
  path: brokenRootPath,
  platform: 'x',
  url: reportedRootUrl,
  savedAt: '2026-08-01T07:22:53.000Z'
}];
// 第一則回覆走 markdown 追加，建立帶 mergeMode='markdown' 的 context
await brokenRootBackground.context.handleSavePost({
  content: '第一則回覆',
  platform: 'x',
  url: reportedReplyUrl,
  replyTo: reportedRootUrl,
  timestamp: '2026-08-02T00:02:53+08:00',
  media: []
}, null);
const brokenRootContextBefore = brokenRootBackground.stored.recentThreadContexts[0];
assert.equal(brokenRootContextBefore.mergeMode, 'markdown');
// markdown 模式的 rootTimestamp 由 status ID 的 snowflake 反推，與母貼文同一刻
assert.ok(
  Math.abs(
    new Date(brokenRootContextBefore.rootTimestamp).getTime()
    - new Date(legacyRootData.timestamp).getTime()
  ) < 1000,
  '合併後的三日窗起點必須是母貼文的發佈時間'
);

// 使用者接著在 Obsidian 把 frontmatter 整段刪掉
brokenRootBackground.setNativeFile(brokenRootPath, '# 我重寫過的筆記\n\n原本的內容\n');
const secondReplyUrl = 'https://x.com/lokunlim/status/2083600000000000000';
await brokenRootBackground.context.handleSavePost({
  content: '母筆記已改壞後的第二則回覆',
  platform: 'x',
  url: secondReplyUrl,
  replyTo: reportedRootUrl,
  timestamp: '2026-08-02T10:00:00+08:00',
  media: []
}, null);
const brokenRootWrite = brokenRootBackground.nativeMessages
  .filter(message => message.action === 'write').at(-1);
assert.notEqual(brokenRootWrite.path, brokenRootPath, 'frontmatter 沒了就不得覆寫母筆記');
assert.match(brokenRootWrite.data, /母筆記已改壞後的第二則回覆/, '回覆內容仍必須寫進 Vault');
const brokenRootContext = brokenRootBackground.stored.recentThreadContexts
  .find(entry => entry.ref?.path === brokenRootWrite.path);
assert.ok(brokenRootContext, '另存的新筆記要有自己的 context');
assert.deepEqual(
  JSON.parse(JSON.stringify(brokenRootContext.mergeUrls)),
  [secondReplyUrl],
  '另存新檔的 mergeUrls 只能是自己的 URL'
);
assert.equal(
  brokenRootContext.rootTimestamp,
  '2026-08-02T10:00:00+08:00',
  '另存新檔的三日窗起點是自己的發佈時間，不是母貼文的'
);
assert.deepEqual(
  JSON.parse(JSON.stringify(brokenRootContext.mergeSegments.map(segment => segment.url))),
  [secondReplyUrl],
  '另存新檔不得沿用母筆記累積的 mergeSegments'
);

// 發文後三天內補充自己的回覆，要覆寫原筆記成串文；連續回覆上一則也要留在同一檔。
const appendedThreadBackground = loadBackground();
appendedThreadBackground.stored.storageProvider = 'markdown-folder';
appendedThreadBackground.stored.basePath = '個人創作/社群推文';
appendedThreadBackground.stored.mediaPath = '附件/順筆';
const appendedRoot = {
  content: '原本的貼文',
  platform: 'x',
  url: 'https://x.com/author/status/7100',
  timestamp: '2026-07-18T11:00:00+08:00',
  media: []
};
await appendedThreadBackground.context.handleSavePost(appendedRoot, null);
await appendedThreadBackground.context.handleSavePost({
  content: '三分鐘後想到的補充',
  platform: 'x',
  url: 'https://x.com/author/status/7101',
  replyTo: appendedRoot.url,
  timestamp: '2026-07-18T11:03:00+08:00',
  media: []
}, null);
await appendedThreadBackground.context.handleSavePost({
  content: '再回覆上一則的補充',
  platform: 'x',
  url: 'https://x.com/author/status/7102',
  replyTo: 'https://x.com/author/status/7101',
  timestamp: '2026-07-18T11:05:00+08:00',
  media: []
}, null);
const appendedThreadWrites = appendedThreadBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(appendedThreadWrites.length, 3);
assert.equal(appendedThreadWrites[1].path, appendedThreadWrites[0].path);
assert.equal(appendedThreadWrites[2].path, appendedThreadWrites[0].path);
assert.equal(parseYamlFrontmatter(appendedThreadWrites[2].data).source_url, appendedRoot.url);
assert.equal(parseYamlFrontmatter(appendedThreadWrites[2].data).post_type, 'thread');
assert.equal(parseYamlFrontmatter(appendedThreadWrites[2].data).thread_count, 3);
assert.match(appendedThreadWrites[2].data, /### 1 \/ 3\n\n```\n原本的貼文\n```/);
assert.match(appendedThreadWrites[2].data, /### 2 \/ 3\n\n```\n三分鐘後想到的補充\n```/);
assert.match(appendedThreadWrites[2].data, /### 3 \/ 3\n\n```\n再回覆上一則的補充\n```/);
assert.equal(appendedThreadBackground.stored.recentSaves.length, 1);

// 超過 72 小時後才追加，以及回覆別人的貼文，都維持各自獨立存檔。
await appendedThreadBackground.context.handleSavePost({
  content: '三天後又一毫秒才追加',
  platform: 'x',
  url: 'https://x.com/author/status/7103',
  replyTo: 'https://x.com/author/status/7102',
  timestamp: '2026-07-21T11:05:00.001+08:00',
  media: []
}, null);
await appendedThreadBackground.context.handleSavePost({
  content: '回覆別人的貼文',
  platform: 'x',
  url: 'https://x.com/author/status/7104',
  replyTo: 'https://x.com/someone/status/7000',
  timestamp: '2026-07-18T11:17:00+08:00',
  media: []
}, null);
const independentWrites = appendedThreadBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.notEqual(independentWrites[3].path, appendedThreadWrites[0].path);
assert.notEqual(independentWrites[4].path, appendedThreadWrites[0].path);

// 邊界採含括判斷：剛好 72 小時仍要合併。
const threeDayBoundaryBackground = loadBackground();
threeDayBoundaryBackground.stored.storageProvider = 'markdown-folder';
threeDayBoundaryBackground.stored.basePath = '個人創作/社群推文';
threeDayBoundaryBackground.stored.mediaPath = '附件/順筆';
await threeDayBoundaryBackground.context.handleSavePost(appendedRoot, null);
await threeDayBoundaryBackground.context.handleSavePost({
  content: '剛好三天後的補充',
  platform: 'x',
  url: 'https://x.com/author/status/7110',
  replyTo: appendedRoot.url,
  timestamp: '2026-07-21T11:00:00+08:00',
  media: []
}, null);
const threeDayBoundaryWrites = threeDayBoundaryBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(threeDayBoundaryWrites[1].path, threeDayBoundaryWrites[0].path);

// 三日窗以母貼文為起點，不因第二天已有補充就再往後展延三天。
const fixedWindowBackground = loadBackground();
fixedWindowBackground.stored.storageProvider = 'markdown-folder';
fixedWindowBackground.stored.basePath = '個人創作/社群推文';
fixedWindowBackground.stored.mediaPath = '附件/順筆';
await fixedWindowBackground.context.handleSavePost(appendedRoot, null);
await fixedWindowBackground.context.handleSavePost({
  content: '第二天的補充',
  platform: 'x',
  url: 'https://x.com/author/status/7120',
  replyTo: appendedRoot.url,
  timestamp: '2026-07-20T11:00:00+08:00',
  media: []
}, null);
await fixedWindowBackground.context.handleSavePost({
  content: '第四天再回覆上一則',
  platform: 'x',
  url: 'https://x.com/author/status/7121',
  replyTo: 'https://x.com/author/status/7120',
  timestamp: '2026-07-22T11:00:00+08:00',
  media: []
}, null);
const fixedWindowWrites = fixedWindowBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(fixedWindowWrites[1].path, fixedWindowWrites[0].path);
assert.notEqual(fixedWindowWrites[2].path, fixedWindowWrites[0].path);

// popup 只保留 5 筆最近儲存；即使母貼文已被擠出清單，三日 context 仍須可合併。
const evictedRecentBackground = loadBackground();
evictedRecentBackground.stored.storageProvider = 'markdown-folder';
evictedRecentBackground.stored.basePath = '個人創作/社群推文';
evictedRecentBackground.stored.mediaPath = '附件/順筆';
await evictedRecentBackground.context.handleSavePost(appendedRoot, null);
const evictedRootPath = evictedRecentBackground.nativeMessages
  .find(message => message.action === 'write').path;
for (let index = 1; index <= 6; index++) {
  await evictedRecentBackground.context.handleSavePost({
    content: `中間的第 ${index} 篇貼文`,
    platform: 'x',
    url: `https://x.com/author/status/72${index}`,
    timestamp: `2026-07-18T12:0${index}:00+08:00`,
    media: []
  }, null);
}
assert.equal(
  evictedRecentBackground.stored.recentSaves.some(item => item.ref?.path === evictedRootPath),
  false
);
await evictedRecentBackground.context.handleSavePost({
  content: '兩天後回頭補充第一篇',
  platform: 'x',
  url: 'https://x.com/author/status/7299',
  replyTo: appendedRoot.url,
  timestamp: '2026-07-20T11:00:00+08:00',
  media: []
}, null);
assert.equal(
  evictedRecentBackground.nativeMessages.filter(message => message.action === 'write').at(-1).path,
  evictedRootPath
);

// 8 秒 DOM 備援先合併、API 稍後帶正式 URL 重送時，要按 composer session 修正原段落，不能重複追加。
const correctedAppendBackground = loadBackground();
correctedAppendBackground.stored.storageProvider = 'markdown-folder';
correctedAppendBackground.stored.basePath = '個人創作/社群推文';
correctedAppendBackground.stored.mediaPath = '附件/順筆';
await correctedAppendBackground.context.handleSavePost({
  ...appendedRoot,
  draftSessionId: 'x:root:1'
}, null);
const appendFallback = {
  content: '網路慢時的補充',
  platform: 'x',
  url: appendedRoot.url,
  replyTo: appendedRoot.url,
  timestamp: '2026-07-18T11:02:00+08:00',
  draftSessionId: 'x:append:1',
  media: []
};
await correctedAppendBackground.context.handleSavePost(appendFallback, null);
await correctedAppendBackground.context.handleSavePost({
  ...appendFallback,
  url: 'https://x.com/author/status/7199'
}, null);
const correctedAppendWrite = correctedAppendBackground.nativeMessages
  .filter(message => message.action === 'write')
  .at(-1);
assert.equal(parseYamlFrontmatter(correctedAppendWrite.data).thread_count, 2);
assert.equal((correctedAppendWrite.data.match(/網路慢時的補充/g) || []).length, 1);
assert.ok(
  correctedAppendBackground.stored.recentThreadContexts[0].mergeUrls.includes(
    'https://x.com/author/status/7199'
  ),
  '遲到修正後要能用正式 URL 繼續串接下一則回覆'
);

// Threads inline composer 傳回目前貼文 URL 後，也要走同一套跨發佈合併邏輯。
const appendedThreadsBackground = loadBackground();
appendedThreadsBackground.stored.storageProvider = 'markdown-folder';
appendedThreadsBackground.stored.basePath = '個人創作/社群推文';
appendedThreadsBackground.stored.mediaPath = '附件/順筆';
const threadsRoot = {
  content: 'Threads 原文',
  platform: 'threads',
  url: 'https://www.threads.com/@author/post/ROOT7100',
  timestamp: '2026-07-18T11:00:00+08:00',
  media: []
};
await appendedThreadsBackground.context.handleSavePost(threadsRoot, null);
await appendedThreadsBackground.context.handleSavePost({
  content: 'Threads 後續補充',
  platform: 'threads',
  url: 'https://www.threads.com/@author/post/REPLY7101',
  replyTo: threadsRoot.url,
  timestamp: '2026-07-18T11:04:00+08:00',
  media: []
}, null);
const appendedThreadsWrites = appendedThreadsBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(appendedThreadsWrites[1].path, appendedThreadsWrites[0].path);
assert.equal(parseYamlFrontmatter(appendedThreadsWrites[1].data).thread_count, 2);
assert.deepEqual(
  parseYamlFrontmatter(appendedThreadsWrites[1].data).tags,
  ['社群貼文', 'Threads', '串文']
);

// ===== 手機貼文補存 =====

function timelineTweet({ id, screen, text, created, conversation, retweet, replyToId, replyToScreen }) {
  const legacy = {
    full_text: text,
    created_at: created,
    conversation_id_str: conversation || id
  };
  if (retweet) legacy.retweeted_status_result = { result: { rest_id: '999' } };
  if (replyToId) {
    legacy.in_reply_to_status_id_str = replyToId;
    legacy.in_reply_to_screen_name = replyToScreen;
  }
  return {
    rest_id: id,
    core: { user_results: { result: { legacy: { screen_name: screen, name: screen } } } },
    legacy
  };
}

function timelineResponse(results) {
  return JSON.stringify({
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: results.map(result => ({
                  content: { itemContent: { tweet_results: { result } } }
                }))
              }]
            }
          }
        }
      }
    }
  });
}

// X 必須有 replyTo 的 DOM 備援：8 秒備援先送出時攔不到 API，
// 少了它 background 就拿不到 replyTo，自回覆永遠接不回母筆記。
const inlineSource = { closest: () => null };
// dialog 內顯示著被回覆的母貼文
const dialogWithParent = {
  closest: (selector) => (selector === '[role="dialog"]' ? {
    querySelector: (sel) => (sel === '[data-testid="tweet"]' ? {
      querySelector: () => ({ getAttribute: () => '/lokunlim/status/2083453394208067681' })
    } : null)
  } : null)
};
// dialog 內沒有母貼文＝一般發文
const dialogWithoutParent = {
  closest: (selector) => (selector === '[role="dialog"]' ? { querySelector: () => null } : null)
};

// 貼文頁的 inline 回覆框：頁面網址就是被回覆的貼文
assert.equal(
  loadTwitterExtractor([], { href: 'https://x.com/lokunlim/status/2083453394208067681' })
    .getReplyTo(inlineSource),
  'https://x.com/lokunlim/status/2083453394208067681'
);
// 首頁的 composer 不是回覆，不得亂猜
assert.equal(
  loadTwitterExtractor([], { href: 'https://x.com/home' }).getReplyTo(inlineSource),
  null
);
// dialog 只認 dialog 內顯示的母貼文，不得拿頁面網址當 replyTo
assert.equal(
  loadTwitterExtractor([], { href: 'https://x.com/lokunlim/status/9999' })
    .getReplyTo(dialogWithParent),
  'https://x.com/lokunlim/status/2083453394208067681'
);
assert.equal(
  loadTwitterExtractor([], { href: 'https://x.com/lokunlim/status/9999' })
    .getReplyTo(dialogWithoutParent),
  null
);

// twitter.js 必須真的把補存監聽接上，並認得出登入帳號
assert.ok(lastBackfillConfig, 'twitter.js 應註冊 createBackfillWatcher');
assert.equal(lastBackfillConfig.platform, 'x');
assert.equal(lastBackfillConfig.getOwnAuthor(), 'me');
// 少了 UserTweetsAndReplies，回覆別人的貼文永遠補不回來（不在「貼文」分頁裡）
assert.ok(
  lastBackfillConfig.scanOperations.includes('UserTweetsAndReplies'),
  'X 的主動掃描必須含「回覆」分頁'
);

// 「回覆」分頁把貼文包在對話模組裡，比一般貼文深兩層。
// 遞迴深度上限訂太低會讓回覆一則都收不到（貼文分頁正常、回覆分頁全空）。
function conversationModuleResponse(results) {
  return JSON.stringify({
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: [{
                  content: {
                    entryType: 'TimelineTimelineModule',
                    items: results.map(result => ({
                      item: { itemContent: { tweet_results: { result } } }
                    }))
                  }
                }]
              }]
            }
          }
        }
      }
    }
  });
}

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toUTCString();

const replyPayload = conversationModuleResponse([
  timelineTweet({
    id: '5002', screen: 'me', text: '我的回覆', created: daysAgo(3),
    conversation: '5001', replyToId: '5001', replyToScreen: 'someone'
  }),
  timelineTweet({ id: '5001', screen: 'someone', text: '別人的原貼文', created: daysAgo(3), conversation: '5001' })
]);
const replyPosts = common.parseUserTweets(replyPayload, 'me');
assert.equal(replyPosts.length, 1);
assert.equal(replyPosts[0].id, '5002');
assert.equal(replyPosts[0].replyTo, 'https://x.com/someone/status/5001');

// 使用者回報的實際漏存案例：2026-07-23 這篇是回覆別人的貼文，
// 所以只看 UserTweets 必然找不到；UserTweetsAndReplies／TweetDetail 必須能建出候選。
const reportedReplyPayload = conversationModuleResponse([
  timelineTweet({
    id: '2080196216038760454',
    screen: 'lokunlim',
    text: '@newrofan 我後來發現緊繃狀態也跟腸胃有關係',
    created: '2026-07-23T07:40:00.000Z',
    conversation: '2080163855192522877',
    replyToId: '2080163855192522877',
    replyToScreen: 'newrofan'
  })
]);
const reportedReplyPosts = common.parseUserTweets(reportedReplyPayload, 'lokunlim');
assert.equal(reportedReplyPosts.length, 1);
assert.equal(reportedReplyPosts[0].id, '2080196216038760454');
// 保留實際 response fixture，但用相對日期驗證 14 天內才建立補存候選，
// 避免這條回歸隨日曆時間自然失效。
const reportedReplyNotes = common.buildBackfillNotes(
  reportedReplyPosts.map(post => ({ ...post, createdAt: daysAgo(3) })),
  'x'
);
assert.equal(
  reportedReplyNotes[0].url,
  'https://x.com/lokunlim/status/2080196216038760454'
);

const recent = daysAgo(2);

const timelinePayload = timelineResponse([
  timelineTweet({ id: '1001', screen: 'me', text: '手機發的第一則', created: recent }),
  timelineTweet({ id: '1002', screen: 'someone', text: '別人的貼文', created: recent }),
  timelineTweet({ id: '1003', screen: 'me', text: '我轉推的', created: recent, retweet: true })
]);

// 只留本人撰寫、非轉推的貼文；別人的貼文絕不能被當成自己的作品補存
const ownPosts = common.parseUserTweets(timelinePayload, 'me');
assert.equal(ownPosts.length, 1);
assert.equal(ownPosts[0].id, '1001');
assert.equal(ownPosts[0].url, 'https://x.com/me/status/1001');
assert.equal(ownPosts[0].createdAt, recent);

// 帳號比對不分大小寫，但認不出帳號時不得回傳任何貼文
assert.equal(common.parseUserTweets(timelinePayload, 'ME').length, 1);
assert.equal(common.parseUserTweets(timelinePayload, '').length, 0);
assert.equal(common.parseUserTweets('not json', 'me'), null);

// 同一串文合併成一個檔，時間用第一則的發佈時間（不是補存當下）
const threadNotes = common.buildBackfillNotes([
  common.parseUserTweets(timelineResponse([
    timelineTweet({ id: '2002', screen: 'me', text: '第二則', created: recent, conversation: '2001' })
  ]), 'me')[0],
  common.parseUserTweets(timelineResponse([
    timelineTweet({ id: '2001', screen: 'me', text: '第一則', created: recent, conversation: '2001' })
  ]), 'me')[0]
], 'x');
assert.equal(threadNotes.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(threadNotes[0].thread)), ['第一則', '第二則']);
assert.equal(threadNotes[0].content, '第一則\n\n---\n\n第二則');
assert.equal(threadNotes[0].url, 'https://x.com/me/status/2001');
assert.equal(threadNotes[0].timestamp, new Date(recent).toISOString());
assert.deepEqual(
  JSON.parse(JSON.stringify(threadNotes[0].threadUrls)),
  ['https://x.com/me/status/2001', 'https://x.com/me/status/2002']
);

// 手機先補存一組快速串文後，三日內回覆第二則也要找到同一份筆記。
const mobileThreadContinuationBackground = loadBackground();
mobileThreadContinuationBackground.stored.storageProvider = 'markdown-folder';
mobileThreadContinuationBackground.stored.basePath = '個人創作/社群推文';
mobileThreadContinuationBackground.stored.mediaPath = '附件/順筆';
await mobileThreadContinuationBackground.context.handleSavePost(threadNotes[0], null);
const mobileThreadRootPath = mobileThreadContinuationBackground.nativeMessages
  .find(message => message.action === 'write').path;
await mobileThreadContinuationBackground.context.handleSavePost({
  content: '隔天回覆手機串文第二則',
  platform: 'x',
  url: 'https://x.com/me/status/2003',
  replyTo: 'https://x.com/me/status/2002',
  timestamp: new Date(new Date(recent).getTime() + 24 * 60 * 60 * 1000).toISOString(),
  media: []
}, null);
const mobileThreadContinuationWrite = mobileThreadContinuationBackground.nativeMessages
  .filter(message => message.action === 'write')
  .at(-1);
assert.equal(mobileThreadContinuationWrite.path, mobileThreadRootPath);
assert.equal(parseYamlFrontmatter(mobileThreadContinuationWrite.data).thread_count, 3);

// 同一 conversation 但相隔數天的貼文是事後追加的回覆，必須各自成篇——
// 併進舊筆記的話會跟著舊檔名被判定為已存在，這則內容就永遠補不回來
const lateReplyNotes = common.buildBackfillNotes([
  common.parseUserTweets(timelineResponse([
    timelineTweet({ id: '4001', screen: 'me', text: '原本那則', created: daysAgo(9), conversation: '4001' })
  ]), 'me')[0],
  common.parseUserTweets(timelineResponse([
    timelineTweet({ id: '4002', screen: 'me', text: '幾天後的追加回覆', created: daysAgo(3), conversation: '4001' })
  ]), 'me')[0]
], 'x');
assert.equal(lateReplyNotes.length, 2);
assert.deepEqual(
  JSON.parse(JSON.stringify(lateReplyNotes.map(note => note.content))),
  ['原本那則', '幾天後的追加回覆']
);
assert.equal(lateReplyNotes[1].url, 'https://x.com/me/status/4002');
// 各自成篇時不該被標記為串文
assert.equal(lateReplyNotes[0].thread, undefined);

// 手機發文後由電腦自動掃描：母貼文與兩天後的自回覆會先逐則比對缺漏，
// 使用者確認補存後仍須合併到母貼文，而不是留下兩份 Markdown。
const mobileRootCreated = daysAgo(2.5);
const mobileReplyCreated = daysAgo(0.5);
const mobileThreeDayNotes = common.buildBackfillNotes([
  common.parseUserTweets(timelineResponse([
    timelineTweet({
      id: '4101', screen: 'me', text: '手機母貼文', created: mobileRootCreated,
      conversation: '4101'
    })
  ]), 'me')[0],
  common.parseUserTweets(timelineResponse([
    timelineTweet({
      id: '4102', screen: 'me', text: '兩天後用手機補充', created: mobileReplyCreated,
      conversation: '4101', replyToId: '4101', replyToScreen: 'me'
    })
  ]), 'me')[0]
], 'x');
assert.equal(mobileThreeDayNotes.length, 2, '補存缺漏必須先逐則比對');
assert.equal(mobileThreeDayNotes[1].replyTo, 'https://x.com/me/status/4101');

const mobileThreeDayBackground = loadBackground();
mobileThreeDayBackground.stored.storageProvider = 'markdown-folder';
mobileThreeDayBackground.stored.basePath = '個人創作/社群推文';
mobileThreeDayBackground.stored.mediaPath = '附件/順筆';
mobileThreeDayBackground.setNativeMode('missing');
assert.deepEqual(
  JSON.parse(JSON.stringify(
    await mobileThreeDayBackground.context.findMissingPosts(mobileThreeDayNotes)
  )),
  {
    ok: true,
    missing: [
      'https://x.com/me/status/4101',
      'https://x.com/me/status/4102'
    ]
  }
);
mobileThreeDayBackground.setNativeMode('ok');
for (const note of mobileThreeDayNotes) {
  await mobileThreeDayBackground.context.handleSavePost(note, null);
}
const mobileThreeDayWrites = mobileThreeDayBackground.nativeMessages
  .filter(message => message.action === 'write');
assert.equal(mobileThreeDayWrites.length, 2);
assert.equal(mobileThreeDayWrites[1].path, mobileThreeDayWrites[0].path);
assert.equal(parseYamlFrontmatter(mobileThreeDayWrites[1].data).thread_count, 2);
assert.match(mobileThreeDayWrites[1].data, /手機母貼文/);
assert.match(mobileThreeDayWrites[1].data, /兩天後用手機補充/);
assert.equal(mobileThreeDayBackground.stored.recentSaves.length, 1);

// 母貼文先補存、隔天另一輪掃描才發現回覆，也要利用三日 context 更新同一檔。
const laterMobileReplyBackground = loadBackground();
laterMobileReplyBackground.stored.storageProvider = 'markdown-folder';
laterMobileReplyBackground.stored.basePath = '個人創作/社群推文';
laterMobileReplyBackground.stored.mediaPath = '附件/順筆';
await laterMobileReplyBackground.context.handleSavePost(mobileThreeDayNotes[0], null);
const earlierMobilePath = laterMobileReplyBackground.nativeMessages
  .find(message => message.action === 'write').path;
laterMobileReplyBackground.setNativeMode('missing');
assert.deepEqual(
  JSON.parse(JSON.stringify(
    await laterMobileReplyBackground.context.findMissingPosts([mobileThreeDayNotes[1]])
  )),
  { ok: true, missing: ['https://x.com/me/status/4102'] }
);
laterMobileReplyBackground.setNativeMode('ok');
await laterMobileReplyBackground.context.handleSavePost(mobileThreeDayNotes[1], null);
assert.equal(
  laterMobileReplyBackground.nativeMessages.filter(message => message.action === 'write').at(-1).path,
  earlierMobilePath
);

// 超過補存時窗的舊貼文不列入：舊筆記用的是沒有時分的舊檔名格式，比對不到會重複建檔
const staleNotes = common.buildBackfillNotes(
  common.parseUserTweets(timelineResponse([
    timelineTweet({ id: '3001', screen: 'me', text: '很久以前', created: daysAgo(30) })
  ]), 'me'),
  'x'
);
assert.equal(staleNotes.length, 0);

// interceptor：時間軸走 GET 並標記 kind=timeline，不可與發文回應混為一談
const timelineInterceptor = loadInterceptor(timelinePayload);
await timelineInterceptor.fetch('https://x.com/i/api/graphql/abc123/UserTweets?variables=%7B%7D');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(timelineInterceptor.messages.length, 1);
assert.equal(timelineInterceptor.messages[0].kind, 'timeline');
assert.equal(timelineInterceptor.messages[0].platform, 'x');

// interceptor 比 content script 早啟動：ready 前已回來的 TweetDetail 必須重送，
// 否則直接開漏存貼文網址時，唯一一份回應會在監聽器註冊前永久遺失。
const bufferedDetail = loadInterceptor('{}');
await bufferedDetail.fetch('https://x.com/i/api/graphql/xyz789/TweetDetail?variables=%7B%7D');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(bufferedDetail.messages.filter(message => message.kind === 'timeline').length, 1);
bufferedDetail.send({ source: 'sp2o-content', action: 'timeline-ready' });
assert.equal(
  bufferedDetail.messages.filter(message => message.kind === 'timeline').length,
  2,
  'ready 後應重送冷啟動期間暫存的 TweetDetail'
);
// buffer 送完即清空；重複 ready 不得再把同一份大型 response 送一次。
bufferedDetail.send({ source: 'sp2o-content', action: 'timeline-ready' });
assert.equal(bufferedDetail.messages.filter(message => message.kind === 'timeline').length, 2);

// 個人頁以外的 GET 不轉發，避免把無關回應送進 content script
const otherInterceptor = loadInterceptor('{}');
await otherInterceptor.fetch('https://x.com/i/api/graphql/abc123/HomeTimeline');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(otherInterceptor.messages.length, 0);

// 開啟單則貼文頁走 TweetDetail：個人頁「貼文」分頁不含回覆別人的貼文，
// 這是唯一能穩定補存單一則（含回覆）的入口
const detailInterceptor = loadInterceptor('{}');
await detailInterceptor.fetch('https://x.com/i/api/graphql/xyz789/TweetDetail?variables=%7B%7D');
await detailInterceptor.fetch('https://x.com/i/api/graphql/xyz789/UserTweetsAndReplies?variables=%7B%7D');
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(
  detailInterceptor.messages.map(message => message.kind),
  ['timeline', 'timeline']
);

// TweetDetail 的對話結構：自己的回覆與對方的原貼文混在同一份回應裡，
// 只能取自己那則，且要保留 reply_to
const tweetDetailPayload = JSON.stringify({
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [{
        type: 'TimelineAddEntries',
        entries: [
          { content: { itemContent: { tweet_results: { result: timelineTweet({
            id: '6001', screen: 'someone', text: '對方的原貼文', created: daysAgo(3), conversation: '6001'
          }) } } } },
          {
            content: {
              items: [{
                item: {
                  itemContent: {
                    tweet_results: {
                      result: timelineTweet({
                        id: '6002', screen: 'me', text: '我回覆別人的貼文', created: daysAgo(3),
                        conversation: '6001', replyToId: '6001', replyToScreen: 'someone'
                      })
                    }
                  }
                }
              }]
            }
          }
        ]
      }]
    }
  }
});
// ---- 主動掃描：content script 端的把關 ----

const X_ORIGIN = 'https://x.com';
const TEMPLATE_URL = 'https://x.com/i/api/graphql/abc123/UserTweetsAndReplies'
  + '?variables=' + encodeURIComponent(JSON.stringify({ userId: '42', count: 40 }))
  + '&features=%7B%7D';
const REAL_HEADERS = {
  authorization: 'Bearer token',
  'x-csrf-token': 'csrf',
  'x-client-transaction-id': 'txn-abc'
};

// 逛別人的個人頁時，那個請求查的是別人的時間軸；重播等於拿使用者的憑證
// 去翻別人的貼文，所以只有在自己的個人頁才能請求掃描。
function loadScannerHarness(pathname) {
  const posted = [];
  const windowStub = {
    listeners: [],
    addEventListener(type, listener) { windowStub.listeners.push(listener); },
    postMessage(message) { posted.push(message); }
  };
  const context = vm.createContext({
    console,
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout() {},
    Object,
    window: windowStub,
    location: { pathname, origin: X_ORIGIN },
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
    chrome: {
      runtime: {
        id: 'test',
        lastError: null,
        getManifest: () => ({ version: manifestVersion }),
        sendMessage(message, callback) { callback?.({ ok: true, missing: [] }); },
        onMessage: { addListener() {} }
      }
    }
  });
  vm.runInContext(readFileSync('content/common.js', 'utf8'), context);
  context.SP2O.createBackfillWatcher({
    platform: 'x',
    label: 'Twitter',
    parseTimeline: () => [],
    getOwnAuthor: () => 'me',
    scanOperations: ['UserTweetsAndReplies']
  });

  return {
    posted,
    scanRequests() {
      return posted.filter(message => message.action === 'scan');
    },
    emit(data) {
      windowStub.listeners.forEach(listener => listener({ source: windowStub, data }));
    }
  };
}

const ownProfileScanner = loadScannerHarness('/me/with_replies');
ownProfileScanner.emit({
  source: 'sp2o-interceptor', platform: 'x', kind: 'timeline',
  operation: 'UserTweetsAndReplies', responseText: '{}'
});
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(
  JSON.parse(JSON.stringify(ownProfileScanner.scanRequests())),
  [{ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] }]
);
assert.equal(
  ownProfileScanner.posted.filter(message => message.action === 'timeline-ready').length,
  1,
  '時間軸監聽器就緒後必須要求重送冷啟動期間的回應'
);

// 同一個端點只請求一次，避免重播回來的回應又觸發一輪掃描
ownProfileScanner.emit({
  source: 'sp2o-interceptor', platform: 'x', kind: 'timeline',
  operation: 'UserTweetsAndReplies', responseText: '{}'
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(ownProfileScanner.scanRequests().length, 1, '重播回應不得再觸發掃描');

// 直接開個人頁網址時，頁面的時間軸請求可能早於 content script 註冊監聽（interceptor
// 在 document_start、common.js 在 document_idle）。若只靠攔截訊息觸發，那次載入
// 完全不會掃描。所以載入後必須主動請求一次，不能等訊息。
const coldStartScanner = loadScannerHarness('/me/with_replies');
assert.deepEqual(
  JSON.parse(JSON.stringify(coldStartScanner.scanRequests())),
  [{ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] }],
  '沒收到任何攔截訊息也要主動請求掃描'
);

// MAIN world 回報掃過了才算完成；沒回報的端點必須還能再試，
// 否則「請求時還沒擷取到、稍後才擷取到」的端點會被永久跳過
const confirmScanner = loadScannerHarness('/me/with_replies');
confirmScanner.emit({
  source: 'sp2o-interceptor', platform: 'x', kind: 'scanned',
  operations: ['UserTweetsAndReplies']
});
const postedAfterConfirm = confirmScanner.scanRequests().length;
confirmScanner.emit({
  source: 'sp2o-interceptor', platform: 'x', kind: 'timeline',
  operation: 'UserTweetsAndReplies', responseText: '{}'
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(confirmScanner.scanRequests().length, postedAfterConfirm, '已回報掃過的端點不再重複請求');

const otherProfileScanner = loadScannerHarness('/someone-else');
otherProfileScanner.emit({
  source: 'sp2o-interceptor', platform: 'x', kind: 'timeline',
  operation: 'UserTweetsAndReplies', responseText: '{}'
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(otherProfileScanner.scanRequests().length, 0, '別人的個人頁不得掃描');

// ---- 主動掃描：不必捲動也要能翻到回覆 ----

// 實測 v2.7.1：x-client-transaction-id 是必要的，少了它 X 一律回 404。
// 沒有簽章的請求不可以被記下來當重播來源，否則掃描一定整批失敗。
const noSignatureInterceptor = loadInterceptor('{}', { origin: X_ORIGIN });
await noSignatureInterceptor.fetch(TEMPLATE_URL, {
  headers: { authorization: 'Bearer token', 'x-csrf-token': 'csrf' }
});
noSignatureInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(
  noSignatureInterceptor.requests.filter(request => request.init && request.init.credentials).length,
  0,
  '沒有 x-client-transaction-id 就不該重播'
);

// 簽章過期時 X 回 404；沒有拿到任何一頁就不能宣稱已掃完，否則 content script
// 會永久停止這個端點的重試，直到整個分頁重載。
const expiredSignatureInterceptor = loadInterceptor('{}', {
  origin: X_ORIGIN,
  replay: () => ({ status: 404, body: '{}' })
});
await expiredSignatureInterceptor.fetch(TEMPLATE_URL, { headers: REAL_HEADERS });
expiredSignatureInterceptor.send({
  source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies']
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(
  expiredSignatureInterceptor.messages.filter(message => message.kind === 'scanned').length,
  0,
  'HTTP 404 的掃描不得被標記為完成'
);

// 掃描會自動翻頁：跟著 Bottom 游標往下取，游標重複（到底）就停
function cursorPage(cursor) {
  return JSON.stringify({
    data: { user: { result: { timeline: { instructions: [{
      entries: [{ content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: cursor } }]
    }] } } } }
  });
}
const scanInterceptor = loadInterceptor('{}', {
  origin: X_ORIGIN,
  replay: (url) => {
    const variables = JSON.parse(new URL(url).searchParams.get('variables') || '{}');
    if (!variables.cursor) return cursorPage('CURSOR_A');
    // 最後一頁：X 會回同一個游標，掃描必須就此停手而不是無限翻頁
    return cursorPage(variables.cursor === 'CURSOR_A' ? 'CURSOR_B' : variables.cursor);
  }
});
await scanInterceptor.fetch(TEMPLATE_URL, { headers: REAL_HEADERS });
scanInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] });
await new Promise(resolve => setTimeout(resolve, 20));
const replayed = scanInterceptor.requests.filter(request => request.init && request.init.credentials);
assert.equal(replayed.length, 3, '應翻三頁後因游標重複而停止');
assert.ok(!replayed[0].url.includes('cursor'), '第一頁不帶 cursor');
assert.ok(replayed[1].url.includes('CURSOR_A'), '第二頁應帶上一頁的 Bottom 游標');
assert.ok(replayed[2].url.includes('CURSOR_B'), '第三頁應帶第二頁的 Bottom 游標');
// 簽章用幾次就失效，所以必須「少次數、大批量」，不能沿用頁面原本的 count
assert.equal(
  JSON.parse(new URL(replayed[0].url).searchParams.get('variables')).count,
  100,
  '重播必須放大每頁筆數'
);
assert.equal(replayed[0].init.headers['x-client-transaction-id'], 'txn-abc');
assert.equal(
  scanInterceptor.messages.filter(message => message.kind === 'timeline').length,
  4,
  '每頁都要轉發給 content script 比對（1 筆是觸發掃描的原始請求）'
);

// 實測回歸：從個人頁點進「回覆」分頁時 UserTweets 先送出、UserTweetsAndReplies 隨後才到。
// 掃描期間抵達的請求若被丟掉，丟掉的正是唯一看得到「回覆別人的貼文」的那個端點，
// 於是那些貼文永遠補不回來（實測就是這樣漏掉 7/23 那則回覆）。
function scannedOperations(interceptor) {
  return interceptor.requests
    .filter(request => request.init && request.init.credentials)
    .map(request => request.url.split('?')[0].split('/').pop());
}
const USER_TWEETS_URL = 'https://x.com/i/api/graphql/abc123/UserTweets?variables=%7B%7D&features=%7B%7D';

const queueInterceptor = loadInterceptor('{}', { origin: X_ORIGIN, replay: () => '{}' });
await queueInterceptor.fetch(USER_TWEETS_URL, { headers: REAL_HEADERS });
await queueInterceptor.fetch(TEMPLATE_URL, { headers: REAL_HEADERS });
queueInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['UserTweets'] });
queueInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] });
await new Promise(resolve => setTimeout(resolve, 50));
assert.deepEqual(
  scannedOperations(queueInterceptor).slice().sort(),
  ['UserTweets', 'UserTweetsAndReplies'],
  '掃描期間抵達的請求不得被丟掉'
);

// 兩個一起排時「回覆」分頁先掃：它是超集合，晚掃可能等到簽章過期
const priorityInterceptor = loadInterceptor('{}', { origin: X_ORIGIN, replay: () => '{}' });
await priorityInterceptor.fetch(USER_TWEETS_URL, { headers: REAL_HEADERS });
await priorityInterceptor.fetch(TEMPLATE_URL, { headers: REAL_HEADERS });
priorityInterceptor.send({
  source: 'sp2o-content', action: 'scan', operations: ['UserTweets', 'UserTweetsAndReplies']
});
await new Promise(resolve => setTimeout(resolve, 50));
assert.deepEqual(
  scannedOperations(priorityInterceptor),
  ['UserTweetsAndReplies', 'UserTweets'],
  '「回覆」分頁必須優先'
);

// 簽章用過即失效：同一次擷取不得被掃第二輪，否則第二輪一定整批 404
scanInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['UserTweetsAndReplies'] });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(
  scanInterceptor.requests.filter(request => request.init && request.init.credentials).length,
  3,
  '用過的請求不得重複掃描'
);

// 頁面上的任何腳本都能偽造 sp2o-content 訊息。網址與標頭一律取自本地擷取，
// 訊息只能指定「掃哪個端點」，所以偽造訊息無法讓憑證被送去別的網址。
const forgedInterceptor = loadInterceptor('{}', { origin: X_ORIGIN, replay: () => '{}' });
forgedInterceptor.send({
  source: 'sp2o-content',
  action: 'scan',
  operations: ['UserTweetsAndReplies', 'DMInbox'],
  templates: { UserTweetsAndReplies: 'https://evil.example/i/api/graphql/abc/UserTweets?variables=%7B%7D' }
});
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(
  forgedInterceptor.requests.filter(request => request.init && request.init.credentials).length,
  0,
  '沒有本地擷取到請求時，偽造訊息不得造成任何重播'
);

// 非本站或非個人頁端點的請求不得被當成重播來源
const foreignInterceptor = loadInterceptor('{}', { origin: X_ORIGIN, replay: () => '{}' });
await foreignInterceptor.fetch('https://x.com/i/api/graphql/abc/DMInbox?variables=%7B%7D', { headers: REAL_HEADERS });
foreignInterceptor.send({ source: 'sp2o-content', action: 'scan', operations: ['DMInbox'] });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(
  foreignInterceptor.requests.filter(request => request.init && request.init.credentials).length,
  0,
  '個人頁以外的端點不得被重播'
);

const detailPosts = common.parseUserTweets(tweetDetailPayload, 'me');
assert.equal(detailPosts.length, 1);
assert.equal(detailPosts[0].id, '6002');
const detailNotes = common.buildBackfillNotes(detailPosts, 'x');
assert.equal(detailNotes.length, 1);
assert.equal(detailNotes[0].content, '我回覆別人的貼文');
assert.equal(detailNotes[0].replyTo, 'https://x.com/someone/status/6001');

// background：Vault 裡沒有的才回報；查得到檔案就不提示
const backfillNote = {
  content: '手機發的第一則',
  platform: 'x',
  url: 'https://x.com/me/status/1001',
  timestamp: '2026-07-18T11:00:00+08:00'
};

const missingBackground = loadBackground();
missingBackground.stored.storageProvider = 'markdown-folder';
missingBackground.setNativeMode('missing');
const missingResult = await missingBackground.context.findMissingPosts([backfillNote]);
assert.deepEqual(
  JSON.parse(JSON.stringify(missingResult)),
  { ok: true, missing: ['https://x.com/me/status/1001'] }
);
// 舊版檔名沒有 _HHmm：只比對現行格式的話，早期存過的筆記會被重複建檔
assert.deepEqual(
  JSON.parse(JSON.stringify(missingBackground.context.candidateFilenames(backfillNote))),
  ['2026-07-18_1100_手機發的第一則.md', '2026-07-18_手機發的第一則.md']
);
assert.deepEqual(
  missingBackground.nativeMessages.filter(message => message.action === 'exists').map(message => message.path),
  [
    '個人創作/社群推文/發文/2026-07-18_1100_手機發的第一則.md',
    '個人創作/社群推文/發文/2026-07-18_手機發的第一則.md',
    '個人創作/社群推文/2026-07-18_1100_手機發的第一則.md',
    '個人創作/社群推文/2026-07-18_手機發的第一則.md'
  ]
);

const existsBackground = loadBackground();
existsBackground.stored.storageProvider = 'markdown-folder';
existsBackground.setNativeFile(
  '個人創作/社群推文/發文/2026-07-18_1100_手機發的第一則.md',
  existsBackground.context.generateMarkdown(backfillNote, [])
);
assert.deepEqual(
  JSON.parse(JSON.stringify(await existsBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: [] }
);

// 實測回歸：同一則貼文從 composer DOM 與從 API 擷取到的文字空行數不同，
// 摘要因此差幾個空白，只比對完整檔名就會把已存過的貼文再存一次
// （Vault 裡真的出現過只差一個空白的兩份）。比對必須改看穩定的 status ID。
const whitespaceBackground = loadBackground();
whitespaceBackground.stored.storageProvider = 'markdown-folder';
whitespaceBackground.setNativeListing(
  ['發文/2026-07-18_1100_手機發的第一則  多了一個空白.md'],
  [{
    name: '發文/2026-07-18_1100_手機發的第一則  多了一個空白.md',
    sourceUrl: 'https://twitter.com/me/status/1001'
  }]
);
assert.deepEqual(
  JSON.parse(JSON.stringify(await whitespaceBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: [] },
  '摘要空白不同不得被當成另一則貼文'
);
assert.equal(
  whitespaceBackground.nativeMessages.filter(message => message.action === 'exists').length,
  0,
  '拿得到檔案清單時就不該再逐檔問 exists'
);
assert.equal(
  whitespaceBackground.nativeMessages.find(message => message.action === 'list').recursive,
  true,
  '分類子資料夾加入後，Vault 索引必須遞迴'
);

// 同一分鐘內可能真的發兩篇；已有別的 status ID 時，不能因檔名前綴相同就漏掉這篇。
const sameMinuteBackground = loadBackground();
sameMinuteBackground.stored.storageProvider = 'markdown-folder';
sameMinuteBackground.setNativeListing(
  ['2026-07-18_1100_同分鐘的另一篇.md'],
  [{
    name: '2026-07-18_1100_同分鐘的另一篇.md',
    sourceUrl: 'https://x.com/me/status/9999'
  }]
);
assert.deepEqual(
  JSON.parse(JSON.stringify(await sameMinuteBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: ['https://x.com/me/status/1001'] },
  '不同 status ID 不得被同分鐘檔名誤判為已存在'
);

// 使用者回報的兩則實際資料：207857… 已有兩份、208019… 尚未存在。
// 比對結果只能提示後者，不能再把前者補成第三份。
const reportedPairBackground = loadBackground();
reportedPairBackground.stored.storageProvider = 'markdown-folder';
reportedPairBackground.setNativeListing(
  [
    '2026-07-19_0418_剛從推友那看到這幅畫ww  瑪竇福音48-10.md',
    '2026-07-19_0418_剛從推友那看到這幅畫ww   瑪竇福音48-10.md'
  ],
  [
    {
      name: '2026-07-19_0418_剛從推友那看到這幅畫ww  瑪竇福音48-10.md',
      sourceUrl: 'https://x.com/lokunlim/status/2078575090405724561'
    },
    {
      name: '2026-07-19_0418_剛從推友那看到這幅畫ww   瑪竇福音48-10.md',
      sourceUrl: 'https://x.com/lokunlim/status/2078575090405724561'
    }
  ]
);
const reportedPairResult = await reportedPairBackground.context.findMissingPosts([
  {
    content: '剛從推友那看到這幅畫ww',
    platform: 'x',
    url: 'https://x.com/lokunlim/status/2078575090405724561',
    timestamp: '2026-07-18T20:18:14.000Z'
  },
  {
    content: '@newrofan 我後來發現緊繃狀態也跟腸胃有關係',
    platform: 'x',
    url: 'https://x.com/lokunlim/status/2080196216038760454',
    timestamp: '2026-07-23T07:40:00.000Z'
  }
]);
assert.deepEqual(
  JSON.parse(JSON.stringify(reportedPairResult)),
  { ok: true, missing: ['https://x.com/lokunlim/status/2080196216038760454'] }
);

// 舊 Host 沒有 entries 時仍保留保守相容行為，避免使用者尚未重裝 Helper 就補出重複檔。
const oldHostBackground = loadBackground();
oldHostBackground.stored.storageProvider = 'markdown-folder';
oldHostBackground.setNativeNames(['2026-07-18_1100_摘要空白不同.md']);
assert.deepEqual(
  JSON.parse(JSON.stringify(await oldHostBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: [] }
);

// 同一分鐘沒有任何筆記才算缺少
const listMissingBackground = loadBackground();
listMissingBackground.stored.storageProvider = 'markdown-folder';
listMissingBackground.setNativeNames(['2026-07-18_1101_鄰近但不同分鐘.md']);
assert.deepEqual(
  JSON.parse(JSON.stringify(await listMissingBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: ['https://x.com/me/status/1001'] }
);

// 查不到 Vault 狀態時視為已存在：寧可漏提示，也不要因為誤判而重複建檔
const brokenBackground = loadBackground();
brokenBackground.stored.storageProvider = 'markdown-folder';
brokenBackground.setNativeMode('down');
assert.deepEqual(
  JSON.parse(JSON.stringify(await brokenBackground.context.findMissingPosts([backfillNote]))),
  { ok: true, missing: [] }
);

// ===== 從一般 x.com 自動啟動本人 replies 背景掃描 =====

const autoScanBackground = loadBackground();
const requester = { url: 'https://x.com/home', tab: { id: 41 } };
const openedScan = await autoScanBackground.context.ensureXBackfillScan('lokunlim', requester);
assert.deepEqual(JSON.parse(JSON.stringify(openedScan)), {
  ok: true,
  scanTab: false,
  inProgress: true,
  opened: true
});
assert.equal(autoScanBackground.createdTabs.length, 1);
assert.equal(autoScanBackground.createdTabs[0].active, false);
assert.equal(autoScanBackground.createdTabs[0].url, 'https://x.com/lokunlim/with_replies');
assert.ok(
  autoScanBackground.alarmCreates.some(item => item.name === 'sp2o-x-backfill-timeout'),
  '背景掃描必須有逾時清理'
);

// 暫存分頁載入後會再次詢問角色；background 必須認出它，不能再開第二個分頁。
const scanTabId = autoScanBackground.createdTabs[0].id;
const scanRole = await autoScanBackground.context.ensureXBackfillScan('lokunlim', {
  url: 'https://x.com/lokunlim/with_replies',
  tab: { id: scanTabId }
});
assert.equal(scanRole.scanTab, true);
assert.equal(autoScanBackground.createdTabs.length, 1);

const relayedCandidate = {
  content: '背景掃描找到的回覆',
  platform: 'x',
  url: 'https://x.com/lokunlim/status/8001',
  timestamp: '2026-07-23T07:40:00.000Z',
  replyTo: 'https://x.com/someone/status/8000'
};
const relayResult = await autoScanBackground.context.relayXBackfillResults([relayedCandidate], {
  url: 'https://x.com/lokunlim/with_replies',
  tab: { id: scanTabId }
});
assert.deepEqual(JSON.parse(JSON.stringify(relayResult)), { ok: true, relayed: true });
assert.equal(autoScanBackground.tabMessages.at(-1).tabId, 41);
assert.equal(autoScanBackground.tabMessages.at(-1).message.type, 'X_BACKFILL_RESULTS');
assert.equal(autoScanBackground.tabMessages.at(-1).message.posts[0].url, relayedCandidate.url);
assert.deepEqual(autoScanBackground.removedTabs, [scanTabId]);
assert.equal('xBackfillScanJob' in autoScanBackground.stored, false);
assert.ok(autoScanBackground.stored.xBackfillLastCompletedAt);

// 15 分鐘冷卻期間，再開其他 x.com 分頁不應重複製造暫存分頁。
const cooldownScan = await autoScanBackground.context.ensureXBackfillScan('lokunlim', {
  url: 'https://x.com/explore',
  tab: { id: 42 }
});
assert.equal(cooldownScan.cooldown, true);
assert.equal(autoScanBackground.createdTabs.length, 1);

// 使用者本來就在自己的 replies 頁時沿用目前頁面，不開背景分頁。
const naturalRepliesBackground = loadBackground();
const naturalReplies = await naturalRepliesBackground.context.ensureXBackfillScan('lokunlim', {
  url: 'https://x.com/lokunlim/with_replies',
  tab: { id: 51 }
});
assert.equal(naturalReplies.opened, false);
assert.equal(naturalRepliesBackground.createdTabs.length, 0);

// 掃描沒有回報時，alarm 仍須關閉暫存分頁並清掉 job。
const timeoutBackground = loadBackground();
await timeoutBackground.context.ensureXBackfillScan('lokunlim', requester);
const timeoutTabId = timeoutBackground.createdTabs[0].id;
timeoutBackground.fireAlarm('sp2o-x-backfill-timeout');
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(timeoutBackground.removedTabs, [timeoutTabId]);
assert.equal('xBackfillScanJob' in timeoutBackground.stored, false);

// 使用者開始撰寫時，停止同一分頁啟動的掃描，避免掃描與草稿同時讀寫 Vault。
const writingBackground = loadBackground();
await writingBackground.context.ensureXBackfillScan('lokunlim', requester);
const writingScanTabId = writingBackground.createdTabs[0].id;
assert.deepEqual(
  JSON.parse(JSON.stringify(await writingBackground.context.cancelXBackfillScan(requester))),
  { ok: true, canceled: true }
);
assert.deepEqual(writingBackground.removedTabs, [writingScanTabId]);
assert.equal('xBackfillScanJob' in writingBackground.stored, false);

// ===== 跨平台相同文章去重 =====

const crossPlatformBackground = loadBackground();
crossPlatformBackground.stored.storageProvider = 'markdown-folder';
const crossPlatformX = {
  content: '同一篇文章\n\n保留標點。',
  platform: 'x',
  url: 'https://x.com/author/status/9001',
  timestamp: '2026-08-20T10:00:00+08:00',
  media: []
};
const crossPlatformThreads = {
  content: '  同一篇文章   保留標點。  ',
  platform: 'threads',
  url: 'https://www.threads.com/@author/post/CROSS9001',
  timestamp: '2026-08-25T14:30:00+08:00',
  media: []
};
await crossPlatformBackground.context.handleSavePost(crossPlatformX, null);
await crossPlatformBackground.context.handleSavePost(crossPlatformThreads, null);
const crossPlatformWrites = crossPlatformBackground.nativeMessages
  .filter(message => message.action === 'write' && message.encoding !== 'base64');
assert.equal(crossPlatformWrites.length, 2, '第二平台應更新 canonical，而不是建立第二篇');
assert.equal(crossPlatformWrites[1].path, crossPlatformWrites[0].path);
assert.equal(crossPlatformBackground.nativeFiles.size, 1);
const crossPlatformYaml = parseYamlFrontmatter(crossPlatformWrites[1].data);
assert.deepEqual(crossPlatformYaml.platforms, ['Twitter/X', 'Threads']);
assert.deepEqual(
  crossPlatformYaml.sources.map(source => source.platform),
  ['x', 'threads']
);
assert.match(crossPlatformYaml.content_fingerprint, /^sha256:[a-f0-9]{64}$/);

// Exercise the real framed Ruby host with an isolated folder, including LANG=C.
{
  const root = mkdtempSync(join(tmpdir(), 'sp2o-lifecycle-'));
  const folder = join(root, '測試資料夾');
  const config = join(root, 'config');
  mkdirSync(folder);
  const nativeRequest = message => sendNativeHostMessage(message, config, { LANG: 'C', LC_ALL: 'C' });
  try {
    assert.equal(nativeRequest({ action: 'configure', folderPath: folder }).ok, true);
    const app = loadBackground({}, { nativeRequest });
    await new Promise(resolve => setImmediate(resolve));
    const media = [{ url: 'https://pbs.twimg.com/media/good.jpg', alt: '隔離測試圖片' }];
    await app.context.handleSavePost({ ...crossPlatformX, media }, null);
    await app.context.handleSavePost({ ...crossPlatformThreads, media }, null);
    const settings = await app.context.getStorageSettings();
    const scope = app.context.dedupeScopeKey(settings);
    const before = await app.context.scanFilePublished(settings);
    assert.equal(before.records.length, 1, '跨平台保存後只有一篇');
    assert.equal(before.records[0].sources.length, 2);
    assert.equal(before.records[0].images.length, 1, '相同圖片只留一份');
    const originalPath = before.records[0].ref.path;
    assert.equal(await app.context.archiveOldSocialPosts(settings, '2026-09-01T00:00:00Z'), 1);
    const after = await app.context.scanFilePublished(settings);
    assert.equal(after.errors.length, 0);
    assert.equal(after.records.length, 1);
    const archived = after.records[0];
    assert.match(archived.ref.path, /Archive\/發文\//);
    assert.equal(existsSync(join(folder, originalPath)), false);
    const markdown = readFileSync(join(folder, archived.ref.path), 'utf8');
    assert.equal(parseYamlFrontmatter(markdown).sources.length, 2);
    for (const image of archived.images) {
      assert.equal(existsSync(join(folder, app.context.recordImagePath(archived, image))), true);
    }
    assert.equal(app.stored.contentDedupeIndex[scope][archived.fingerprint][0].ref.path, archived.ref.path);
    assert.equal(app.stored.recentSaves[0].ref.path, archived.ref.path);
    assert.equal(await app.context.archiveOldSocialPosts(settings, '2026-09-01T00:00:00Z'), 0);
    assert.equal((await app.context.checkContentIndex()).issues.length, 0);
    console.log('Isolated real Helper lifecycle passed: save → merge → archive → read-back; images intact; rerun moved 0.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Index checks are read-only; repair requires the same scope, snapshot and revision.
{
  const app = loadBackground();
  await new Promise(resolve => setImmediate(resolve));
  await app.context.handleSavePost(crossPlatformX, null);
  const settings = await app.context.getStorageSettings();
  const scope = app.context.dedupeScopeKey(settings);
  const fingerprint = await app.context.contentFingerprint(crossPlatformX);
  const entry = app.stored.contentDedupeIndex[scope][fingerprint][0];
  const from = entry.ref.path;
  const to = from.replace('/2026-', '/Archive/發文/2026-');
  const markdown = app.nativeFiles.get(from);
  app.nativeFiles.delete(from);
  app.setNativeFile(to, markdown);
  app.setNativeNames([to.replace(settings.basePath + '/', '')]);
  const snapshot = JSON.stringify(app.stored.contentDedupeIndex);
  const preview = await app.context.checkContentIndex();
  assert.equal(preview.issues.length, 1);
  assert.equal(preview.issues[0].replacement.ref.path, to);
  assert.equal(JSON.stringify(app.stored.contentDedupeIndex), snapshot, '檢查不可更新索引');
  assert.equal((await app.context.getMaintenanceStatus()).indexCheck.scanId, preview.scanId,
    '關閉 Popup 後能恢復預覽');
  app.stored.storageProvider = 'obsidian-rest';
  await assert.rejects(app.context.repairContentIndex(preview.scanId), /目的地/);
  app.stored.storageProvider = 'markdown-folder';
  app.setNativeFile(to, markdown + '\n手動補充');
  assert.equal((await app.context.repairContentIndex(preview.scanId)).repaired, 0, '預覽後手改要略過');
  const next = await app.context.checkContentIndex();
  const messagesBefore = app.nativeMessages.length;
  assert.equal((await app.context.repairContentIndex(next.scanId)).repaired, 1);
  assert.equal(app.stored.contentDedupeIndex[scope][fingerprint][0].ref.path, to);
  assert.equal(app.nativeMessages.slice(messagesBefore).some(message => ['write', 'remove'].includes(message.action)), false);
  await assert.rejects(app.context.repairContentIndex(next.scanId), /已完成/);
  assert.equal((await app.context.checkContentIndex()).issues.length, 0);
  // Missing content remains indexed for manual investigation, never silently discarded.
  app.nativeFiles.delete(to);
  app.setNativeNames([]);
  const missing = await app.context.checkContentIndex();
  assert.equal(missing.issues[0].replacement, null);
  assert.equal((await app.context.repairContentIndex(missing.scanId)).repaired, 0);
  assert.equal(app.stored.contentDedupeIndex[scope][fingerprint].length, 1);
  app.setNativeNames(['unreadable.md']);
  await assert.rejects(app.context.checkContentIndex(), /掃描不完整/);
  assert.equal(app.stored.contentDedupeIndex[scope][fingerprint].length, 1);
}

for (const provider of ['obsidian-rest', 'apple-notes']) {
  const app = loadBackground({
    storageProvider: provider,
    appleNotesSettings: { accountId: 'account-local', folderId: 'folder-test' }
  });
  await new Promise(resolve => setImmediate(resolve));
  await app.context.handleSavePost(crossPlatformX, null);
  const settings = await app.context.getStorageSettings();
  const scope = app.context.dedupeScopeKey(settings);
  const fingerprint = await app.context.contentFingerprint(crossPlatformX);
  const entry = app.stored.contentDedupeIndex[scope][fingerprint][0];
  const originalRef = { ...entry.ref };
  // Simulate an obsolete reference while the destination retains the original note.
  entry.ref = provider === 'apple-notes'
    ? { ...entry.ref, noteId: 'missing-note' }
    : { ...entry.ref, path: '個人創作/社群推文/missing.md' };
  app.stored.contentDedupeIndex['unrelated-location'] = { [fingerprint]: [JSON.parse(JSON.stringify(entry))] };
  const foreign = JSON.stringify(app.stored.contentDedupeIndex['unrelated-location']);
  const callsBeforeStatus = app.nativeMessages.length;
  await app.context.getMaintenanceStatus();
  assert.equal(app.nativeMessages.length, callsBeforeStatus, '讀取背景狀態不得掃描 Notes');
  const preview = await app.context.checkContentIndex();
  assert.equal(preview.issues.length, 1, provider);
  assert.equal(app.context.SP2OStorage.refKey(preview.issues[0].replacement.ref),
    app.context.SP2OStorage.refKey(originalRef), provider);
  assert.equal((await app.context.repairContentIndex(preview.scanId)).repaired, 1, provider);
  assert.equal(JSON.stringify(app.stored.contentDedupeIndex['unrelated-location']), foreign);
}

{
  const app = loadBackground();
  await new Promise(resolve => setImmediate(resolve));
  await app.context.handleSavePost(crossPlatformX, null);
  const settings = await app.context.getStorageSettings();
  const scope = app.context.dedupeScopeKey(settings);
  const fingerprint = await app.context.contentFingerprint(crossPlatformX);
  const entry = app.stored.contentDedupeIndex[scope][fingerprint][0];
  const original = entry.ref.path;
  const markdown = app.nativeFiles.get(original);
  entry.ref.path = '個人創作/社群推文/missing.md';
  app.setNativeFile('個人創作/社群推文/copy.md', markdown);
  app.setNativeNames([original.split('/').at(-1), 'copy.md']);
  const ambiguous = await app.context.checkContentIndex();
  assert.equal(ambiguous.issues[0].replacement, null, '多筆相符不得猜測');
  app.nativeFiles.delete('個人創作/社群推文/copy.md');
  app.setNativeNames([original.split('/').at(-1)]);
  const preview = await app.context.checkContentIndex();
  app.stored.contentDedupeIndex[scope][fingerprint][0] = { ...entry, title: 'changed concurrently' };
  assert.equal((await app.context.repairContentIndex(preview.scanId)).repaired, 0,
    '檢查後索引變更不得被舊預覽覆寫');
}

const splitThreadFingerprint = await crossPlatformBackground.context.contentFingerprint({
  ...crossPlatformX,
  content: 'unused',
  thread: ['同一篇文章', '保留標點。']
});
assert.equal(
  splitThreadFingerprint,
  await crossPlatformBackground.context.contentFingerprint(crossPlatformThreads),
  '串文接成全文後應與單篇使用相同 fingerprint'
);
assert.equal(await crossPlatformBackground.context.contentFingerprint({
  ...crossPlatformX,
  replyTo: 'https://x.com/other/status/1'
}), '', '回覆不可進入跨平台去重');
assert.equal(await crossPlatformBackground.context.contentFingerprint({
  ...crossPlatformX,
  quoted: { content: '引用內容' }
}), '', '引用貼文不可進入跨平台去重');

const samePlatformBackground = loadBackground();
samePlatformBackground.stored.storageProvider = 'markdown-folder';
await samePlatformBackground.context.handleSavePost(crossPlatformX, null);
await samePlatformBackground.context.handleSavePost({
  ...crossPlatformX,
  url: 'https://x.com/author/status/9002',
  timestamp: '2026-08-20T10:00:30+08:00'
}, null);
const samePlatformWrites = samePlatformBackground.nativeMessages
  .filter(message => message.action === 'write' && message.encoding !== 'base64');
assert.notEqual(samePlatformWrites[1].path, samePlatformWrites[0].path, '同平台重發必須另存且不可覆寫同名檔');
assert.equal(samePlatformBackground.nativeFiles.size, 2);

// 既有資料只在掃描階段建立預覽；使用者確認前不得寫入或刪除。
const duplicateScanBackground = loadBackground();
duplicateScanBackground.stored.storageProvider = 'markdown-folder';
const oldXPath = '個人創作/社群推文/2026-07-01_0900_既有文章.md';
const oldThreadsPath = '個人創作/社群推文/2026-07-02_0900_既有文章.md';
duplicateScanBackground.setNativeFile(oldXPath, duplicateScanBackground.context.generateMarkdown({
  ...crossPlatformX,
  content: '既有文章',
  timestamp: '2026-07-01T09:00:00+08:00'
}, []));
duplicateScanBackground.setNativeFile(oldThreadsPath, duplicateScanBackground.context.generateMarkdown({
  ...crossPlatformThreads,
  content: '既有文章',
  timestamp: '2026-07-02T09:00:00+08:00'
}, []));
duplicateScanBackground.setNativeListing(
  [oldXPath.replace('個人創作/社群推文/', ''), oldThreadsPath.replace('個人創作/社群推文/', '')],
  [
    { name: oldXPath.replace('個人創作/社群推文/', ''), sourceUrl: crossPlatformX.url },
    { name: oldThreadsPath.replace('個人創作/社群推文/', ''), sourceUrl: crossPlatformThreads.url }
  ]
);
const messagesBeforeScan = duplicateScanBackground.nativeMessages.length;
const scanPreview = await duplicateScanBackground.context.scanDuplicatePosts();
assert.equal(scanPreview.ok, true);
assert.equal(scanPreview.groups.length, 1);
assert.equal(scanPreview.groups[0].canonical.ref.path, oldXPath);
assert.equal(
  duplicateScanBackground.nativeMessages.slice(messagesBeforeScan).some(message => ['write', 'remove'].includes(message.action)),
  false,
  '掃描預覽不可修改目的地'
);
const partialScope = duplicateScanBackground.context.dedupeScopeKey(
  await duplicateScanBackground.context.getStorageSettings()
);
duplicateScanBackground.stored.contentDedupeIndex[partialScope].unreadable = [{
  ref: { provider: 'markdown-folder', path: '個人創作/社群推文/unreadable.md' },
  sources: [], platforms: ['Twitter/X'], title: 'Unreadable indexed post'
}];
const indexBeforePartialScan = JSON.parse(JSON.stringify(duplicateScanBackground.stored.contentDedupeIndex));
duplicateScanBackground.setNativeNames([
  oldXPath.split('/').at(-1), oldThreadsPath.split('/').at(-1), 'unreadable.md'
]);
const partialScan = await duplicateScanBackground.context.scanDuplicatePosts();
assert.deepEqual(JSON.parse(JSON.stringify(duplicateScanBackground.stored.contentDedupeIndex)),
  indexBeforePartialScan, '部分掃描失敗必須保留原 contentDedupeIndex');
const partialProvider = partialScan.providers.find(provider => provider.provider === 'markdown-folder');
assert.equal(partialProvider.ok, false, '部分掃描不可回報完全成功');
assert.equal(partialProvider.complete, false, 'provider 必須標示掃描不完整');
assert.match(partialProvider.warnings.join('\n'), /unreadable/);
assert.equal(partialScan.groups.length, 1, '部分掃描仍保留可用預覽');
const restoredPartialScan = await duplicateScanBackground.context.getDuplicateScanSession();
assert.deepEqual(restoredPartialScan.providers, partialScan.providers, '重開 Popup 必須保留不完整狀態及警告');
assert.equal(restoredPartialScan.groups.length, 1);
const duplicatePopup = vm.createContext({
  document: { createElement: () => ({ append() {} }) },
  duplicateResults: { textContent: '', children: [], appendChild(child) { this.children.push(child); } },
  duplicateStatus: {}, duplicateScanBtn: {}, duplicateMergeBtn: {},
  providerLabel: value => value,
  platformDisplayName: value => value,
  chrome: { runtime: { sendMessage: async () => restoredPartialScan } }
});
vm.runInContext(`let duplicateScanId = '';
  ${popupScript.slice(popupScript.indexOf('function renderDuplicateResults('),
    popupScript.indexOf('function maintenanceTime('))}`, duplicatePopup);
await duplicatePopup.scanDuplicatePosts();
assert.match(duplicatePopup.duplicateStatus.textContent, /掃描不完整/);
assert.ok(duplicatePopup.duplicateResults.children.some(child =>
  child.className === 'duplicate-provider-status error' && /掃描不完整/.test(child.textContent)));
assert.ok(duplicatePopup.duplicateResults.children.some(child => /unreadable/.test(child.textContent)),
  'Popup 必須以文字呈現讀取失敗原因');
await duplicatePopup.restoreDuplicateScan();
assert.match(duplicatePopup.duplicateStatus.textContent, /上次掃描不完整/);
duplicateScanBackground.setNativeNames([oldXPath.split('/').at(-1), oldThreadsPath.split('/').at(-1)]);
const completeScan = await duplicateScanBackground.context.scanDuplicatePosts();
assert.equal(completeScan.providers[0].ok, true);
assert.equal(completeScan.providers[0].complete, true);
const mergePreview = await duplicateScanBackground.context.mergeDuplicatePosts(
  completeScan.scanId,
  [completeScan.groups[0].id]
);
assert.equal(mergePreview.ok, true);
assert.equal(mergePreview.merged, 1);
assert.equal(duplicateScanBackground.nativeFiles.has(oldXPath), true);
assert.equal(duplicateScanBackground.nativeFiles.has(oldThreadsPath), false);
assert.deepEqual(parseYamlFrontmatter(duplicateScanBackground.nativeFiles.get(oldXPath)).platforms, ['Twitter/X', 'Threads']);

// Local REST 與 Apple 備忘錄也要走同一套自動去重，不能只修 Markdown Helper。
const restCrossPlatformBackground = loadBackground();
restCrossPlatformBackground.stored.storageProvider = 'obsidian-rest';
await restCrossPlatformBackground.context.handleSavePost(crossPlatformX, null);
await restCrossPlatformBackground.context.handleSavePost(crossPlatformThreads, null);
const restCrossMarkdownPaths = restCrossPlatformBackground.getRestPaths().filter(path => path.endsWith('.md'));
assert.equal(restCrossMarkdownPaths.length, 1);
assert.deepEqual(
  parseYamlFrontmatter(restCrossPlatformBackground.getRestFile(restCrossMarkdownPaths[0])).platforms,
  ['Twitter/X', 'Threads']
);

const notesCrossPlatformBackground = loadBackground({
  storageProvider: 'apple-notes',
  appleNotesSettings: {
    accountId: 'account-local',
    accountName: 'On My Mac',
    folderId: 'folder-test',
    folderName: 'SP2O Tests'
  }
});
await notesCrossPlatformBackground.context.handleSavePost(crossPlatformX, null);
await notesCrossPlatformBackground.context.handleSavePost(crossPlatformThreads, null);
assert.equal(notesCrossPlatformBackground.getNativeNotes().length, 1);
const mergedNotesHtml = notesCrossPlatformBackground.getNativeNotes()[0].html;
assert.match(mergedNotesHtml, /平台：<\/strong>Twitter\/X、Threads/);
assert.match(mergedNotesHtml, /status\/9001/);
assert.match(mergedNotesHtml, /post\/CROSS9001/);
assert.match(mergedNotesHtml, /內容指紋：<\/strong>sha256:[a-f0-9]{64}/);

const existingNotesScanBackground = loadBackground({
  storageProvider: 'apple-notes',
  markdownFolderSettings: { basePath: '個人創作/社群推文', mediaPath: '附件', folderName: '' },
  obsidianRestSettings: { apiKey: '', port: 27123, basePath: '個人創作/社群推文', mediaPath: '附件' },
  appleNotesSettings: {
    accountId: 'account-local',
    accountName: 'On My Mac',
    folderId: 'folder-test',
    folderName: 'SP2O Tests'
  }
});
existingNotesScanBackground.setNativeNote({
  noteId: 'note-existing-x',
  title: 'Apple 既有文章',
  externalKey: 'x:9001',
  createdAt: '2026-04-01T09:00:00+08:00',
  html: existingNotesScanBackground.context.renderNotesHtml({
    ...crossPlatformX,
    content: 'Apple 既有文章',
    timestamp: '2026-04-01T09:00:00+08:00'
  }, 'Apple 既有文章', 'x:9001'),
  attachments: []
});
existingNotesScanBackground.setNativeNote({
  noteId: 'note-existing-threads',
  title: 'Apple 既有文章',
  externalKey: 'threads:CROSS9001',
  createdAt: '2026-04-02T09:00:00+08:00',
  html: existingNotesScanBackground.context.renderNotesHtml({
    ...crossPlatformThreads,
    content: 'Apple 既有文章',
    timestamp: '2026-04-02T09:00:00+08:00'
  }, 'Apple 既有文章', 'threads:CROSS9001'),
  attachments: []
});
const existingNotesScan = await existingNotesScanBackground.context.scanDuplicatePosts();
const existingNotesGroup = existingNotesScan.groups.find(group => group.provider === 'apple-notes');
assert.ok(existingNotesGroup);
assert.equal((await existingNotesScanBackground.context.mergeDuplicatePosts(
  existingNotesScan.scanId,
  [existingNotesGroup.id]
)).merged, 1);
assert.equal(existingNotesScanBackground.getNativeNotes().length, 1);

const existingRestScanBackground = loadBackground({
  storageProvider: 'obsidian-rest',
  markdownFolderSettings: { basePath: '個人創作/社群推文', mediaPath: '附件', folderName: '' },
  appleNotesSettings: {},
  obsidianRestSettings: {
    apiKey: 'test-key',
    port: 27123,
    basePath: '個人創作/社群推文',
    mediaPath: '附件/順筆'
  }
});
existingRestScanBackground.setRestFile(oldXPath, existingRestScanBackground.context.generateMarkdown({
  ...crossPlatformX,
  content: 'REST 既有文章',
  timestamp: '2026-03-01T09:00:00+08:00'
}, []));
existingRestScanBackground.setRestFile(oldThreadsPath, existingRestScanBackground.context.generateMarkdown({
  ...crossPlatformThreads,
  content: 'REST 既有文章',
  timestamp: '2026-03-02T09:00:00+08:00'
}, []));
const existingRestScan = await existingRestScanBackground.context.scanDuplicatePosts();
const existingRestGroup = existingRestScan.groups.find(group => group.provider === 'obsidian-rest');
assert.ok(existingRestGroup);
assert.equal((await existingRestScanBackground.context.mergeDuplicatePosts(
  existingRestScan.scanId,
  [existingRestGroup.id]
)).merged, 1);
assert.equal(existingRestScanBackground.hasRestFile(oldXPath), true);
assert.equal(existingRestScanBackground.hasRestFile(oldThreadsPath), false);

// 重複筆記含手動區塊時要移到 canonical 的「合併保留內容」。
const manualMergeBackground = loadBackground();
manualMergeBackground.stored.storageProvider = 'markdown-folder';
const manualXPath = '個人創作/社群推文/2026-06-01_0900_手動內容.md';
const manualThreadsPath = '個人創作/社群推文/2026-06-02_0900_手動內容.md';
manualMergeBackground.setNativeFile(manualXPath, manualMergeBackground.context.generateMarkdown({
  ...crossPlatformX,
  content: '要保留手動補充的文章',
  timestamp: '2026-06-01T09:00:00+08:00'
}, []));
manualMergeBackground.setNativeFile(
  manualThreadsPath,
  `${manualMergeBackground.context.generateMarkdown({
    ...crossPlatformThreads,
    content: '要保留手動補充的文章',
    timestamp: '2026-06-02T09:00:00+08:00'
  }, []).trim()}\n\n---\n\n## 我手動補的資料\n\n這段不能消失。\n`
);
manualMergeBackground.setNativeListing(
  [manualXPath.split('/').at(-1), manualThreadsPath.split('/').at(-1)],
  [
    { name: manualXPath.split('/').at(-1), sourceUrl: crossPlatformX.url },
    { name: manualThreadsPath.split('/').at(-1), sourceUrl: crossPlatformThreads.url }
  ]
);
const manualScan = await manualMergeBackground.context.scanDuplicatePosts();
const manualGroup = manualScan.groups.find(group => group.canonical.ref.path === manualXPath);
assert.ok(manualGroup);
const manualMerged = await manualMergeBackground.context.mergeDuplicatePosts(manualScan.scanId, [manualGroup.id]);
assert.equal(manualMerged.merged, 1);
assert.match(manualMergeBackground.nativeFiles.get(manualXPath), /## 合併保留內容[\s\S]*## 我手動補的資料[\s\S]*這段不能消失。/);

// 圖片以位元 SHA-256 判斷：相同檔只留一份，不同位元即使名稱相同仍保留。
const imageMergeBackground = loadBackground();
imageMergeBackground.stored.storageProvider = 'markdown-folder';
const imageXPath = '個人創作/社群推文/2026-05-01_0900_圖片文章.md';
const imageThreadsPath = '個人創作/社群推文/2026-05-02_0900_圖片文章.md';
const xAsset = '附件/順筆/2026-05-01_0900_圖片文章/image-01.jpg';
const threadsAsset1 = '附件/順筆/2026-05-02_0900_圖片文章/image-01.jpg';
const threadsAsset2 = '附件/順筆/2026-05-02_0900_圖片文章/image-02.jpg';
imageMergeBackground.setNativeFile(xAsset, Buffer.from([1, 2, 3]));
imageMergeBackground.setNativeFile(threadsAsset1, Buffer.from([1, 2, 3]));
imageMergeBackground.setNativeFile(threadsAsset2, Buffer.from([9, 8, 7]));
imageMergeBackground.setNativeFile(imageXPath, imageMergeBackground.context.generateMarkdown({
  ...crossPlatformX,
  content: '圖片去重文章',
  timestamp: '2026-05-01T09:00:00+08:00'
}, [{ path: '../../附件/順筆/2026-05-01_0900_圖片文章/image-01.jpg', alt: 'X 圖片' }]));
imageMergeBackground.setNativeFile(imageThreadsPath, imageMergeBackground.context.generateMarkdown({
  ...crossPlatformThreads,
  content: '圖片去重文章',
  timestamp: '2026-05-02T09:00:00+08:00'
}, [
  { path: '../../附件/順筆/2026-05-02_0900_圖片文章/image-01.jpg', alt: '相同圖片' },
  { path: '../../附件/順筆/2026-05-02_0900_圖片文章/image-02.jpg', alt: '不同圖片' }
]));
imageMergeBackground.setNativeListing(
  [imageXPath.split('/').at(-1), imageThreadsPath.split('/').at(-1)],
  [
    { name: imageXPath.split('/').at(-1), sourceUrl: crossPlatformX.url },
    { name: imageThreadsPath.split('/').at(-1), sourceUrl: crossPlatformThreads.url }
  ]
);
const imageScan = await imageMergeBackground.context.scanDuplicatePosts();
const imageGroup = imageScan.groups.find(group => group.canonical.ref.path === imageXPath);
assert.ok(imageGroup);
assert.equal((await imageMergeBackground.context.mergeDuplicatePosts(imageScan.scanId, [imageGroup.id])).merged, 1);
const imageMergedMarkdown = imageMergeBackground.nativeFiles.get(imageXPath);
assert.equal((imageMergedMarkdown.match(/^!\[/gm) || []).length, 2);
assert.equal(imageMergeBackground.nativeFiles.has(xAsset), true);
assert.equal(imageMergeBackground.nativeFiles.has(threadsAsset1), false);
assert.equal(imageMergeBackground.nativeFiles.has(threadsAsset2), false);

// 掃描後內容被修改時必須整組跳過，不得套用過期預覽後刪除。
const staleScanBackground = loadBackground();
staleScanBackground.stored.storageProvider = 'markdown-folder';
staleScanBackground.setNativeFile(oldXPath, duplicateScanBackground.context.generateMarkdown({
  ...crossPlatformX,
  content: '掃描後會變更',
  timestamp: '2026-07-01T09:00:00+08:00'
}, []));
staleScanBackground.setNativeFile(oldThreadsPath, duplicateScanBackground.context.generateMarkdown({
  ...crossPlatformThreads,
  content: '掃描後會變更',
  timestamp: '2026-07-02T09:00:00+08:00'
}, []));
staleScanBackground.setNativeListing(
  [oldXPath.split('/').at(-1), oldThreadsPath.split('/').at(-1)],
  [
    { name: oldXPath.split('/').at(-1), sourceUrl: crossPlatformX.url },
    { name: oldThreadsPath.split('/').at(-1), sourceUrl: crossPlatformThreads.url }
  ]
);
const staleScan = await staleScanBackground.context.scanDuplicatePosts();
staleScanBackground.setNativeFile(oldThreadsPath, `${staleScanBackground.nativeFiles.get(oldThreadsPath)}\n手動變更\n`);
const staleMerge = await staleScanBackground.context.mergeDuplicatePosts(staleScan.scanId, [staleScan.groups[0].id]);
assert.equal(staleMerge.merged, 0);
assert.equal(staleMerge.skipped, 1);
assert.equal(staleScanBackground.nativeFiles.has(oldThreadsPath), true);
assert.equal(duplicateScanBackground.context.duplicateGroupsForRecords('markdown-folder', [{
  ref: { provider: 'markdown-folder', path: 'canonical.md' },
  fingerprint: 'sha256:retry',
  createdAt: '2026-01-01T00:00:00Z',
  platforms: ['x', 'threads'],
  sources: [
    { platform: 'x', externalKey: 'x:1' },
    { platform: 'threads', externalKey: 'threads:1' }
  ]
}, {
  ref: { provider: 'markdown-folder', path: 'duplicate.md' },
  fingerprint: 'sha256:retry',
  createdAt: '2026-01-02T00:00:00Z',
  platforms: ['threads'],
  sources: [{ platform: 'threads', externalKey: 'threads:1' }]
}]).length, 1, 'canonical 已更新但重複檔刪除失敗時，下次掃描仍須能續刪');

console.log('Media parser and Vault bundle tests passed.');
