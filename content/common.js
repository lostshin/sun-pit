// 共用工具（ISOLATED world）：訊息傳送、攔截事件接收、發文 API 回應解析
// 由 manifest 在各平台 content script 之前載入
var SP2O = (function () {
  'use strict';

  const LOG = '[順筆]';

  // 啟動時印出版本，方便確認此分頁載入的是哪一版（重載擴充功能後需重新整理分頁）
  try {
    console.log(LOG, 'content script v' + chrome.runtime.getManifest().version + ' 已載入');
  } catch (e) { /* 測試環境或 context 失效時略過 */ }

  // 發送訊息到 background（帶重試機制，處理 service worker 尚未喚醒的情況）
  function sendMessage(message, maxRetries = 3) {
    let retries = 0;

    function trySend() {
      // 整段包 try/catch：context 失效時，連讀取 chrome.runtime.id
      // 都可能同步丟出 "Extension context invalidated"
      try {
        // 擴充功能重載後，舊分頁裡的 content script 會失效，重試無用
        if (!chrome.runtime?.id) {
          handleInvalidated();
          return;
        }

        chrome.runtime.sendMessage(message, () => {
          try {
            const err = chrome.runtime.lastError;
            if (!err) return;

            if (/context invalidated/i.test(err.message || '')) {
              handleInvalidated();
              return;
            }

            retries++;
            if (retries < maxRetries) {
              setTimeout(trySend, 500);
            } else {
              console.error(LOG, '發送失敗，已達最大重試次數:', err.message);
            }
          } catch (e) {
            handleInvalidated();
          }
        });
      } catch (e) {
        handleInvalidated();
      }
    }

    trySend();
  }

  // 需要 background 回覆的查詢。與 sendMessage 不同：不重試（查詢失敗就當作
  // 沒有結果，下一批時間軸回應會再問一次），失敗一律 resolve(null) 不丟例外。
  function sendRequest(message) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime?.id) {
          handleInvalidated();
          resolve(null);
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (/context invalidated/i.test(err.message || '')) handleInvalidated();
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (e) {
        handleInvalidated();
        resolve(null);
      }
    });
  }

  // context 失效只提醒一次：toast 是純 DOM，失效後仍可顯示
  let invalidatedNotified = false;
  function handleInvalidated() {
    if (invalidatedNotified) return;
    invalidatedNotified = true;
    // 用 log 而非 warn：warn 會被收進擴充功能錯誤頁，這是預期情況不該佔版面
    console.log(LOG, '擴充功能已重新載入，此分頁的舊指令碼已失效，請重新整理頁面');
    showToast('擴充功能已更新，請重新整理此頁面以繼續存檔', false);
  }

  // ===== 頁面內 toast（存檔結果即時回饋）=====
  let toastTimer = null;

  function showToast(text, ok) {
    let el = document.getElementById('sp2o-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sp2o-toast';
      el.style.cssText = [
        // 比草稿狀態列高一階，兩者可同時顯示不重疊
        'position:fixed', 'bottom:64px', 'right:24px', 'z-index:2147483647',
        'padding:10px 16px', 'border-radius:8px', 'font-size:14px', 'color:#fff',
        'font-family:system-ui,-apple-system,sans-serif', 'max-width:320px',
        'box-shadow:0 4px 12px rgba(0,0,0,.35)', 'opacity:0',
        'transition:opacity .25s ease', 'pointer-events:none'
      ].join(';');
      document.documentElement.appendChild(el);
    }
    el.style.background = ok ? '#1e7e34' : '#b02a37';
    el.textContent = (ok ? '✓ ' : '✕ ') + text;
    // 強制 reflow 讓 transition 生效；不用 rAF（背景分頁會延後執行，
    // 導致淡出比淡入先跑、toast 卡住不消失）
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3500);
  }

  // ===== 草稿暫存狀態列（低調常駐小膠囊，每次暫存更新時間）=====
  let draftStatusTimer = null;

  function showDraftStatus(text, ok) {
    let el = document.getElementById('sp2o-draft-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sp2o-draft-status';
      el.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483646',
        'padding:5px 12px', 'border-radius:999px', 'font-size:12px', 'color:#fff',
        'font-family:system-ui,-apple-system,sans-serif', 'max-width:280px',
        'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'opacity:0',
        'transition:opacity .25s ease', 'pointer-events:none'
      ].join(';');
      document.documentElement.appendChild(el);
    }
    el.style.background = ok ? 'rgba(45,55,72,.88)' : 'rgba(146,64,14,.92)';
    el.textContent = (ok ? '✓ ' : '⚠ ') + text;
    void el.offsetWidth;
    el.style.opacity = '1';
    clearTimeout(draftStatusTimer);
    // 兩秒後淡到半透明常駐（不完全消失，隨時可瞄一眼暫存時間）
    draftStatusTimer = setTimeout(() => { el.style.opacity = '0.55'; }, 2000);
  }

  function hideDraftStatus() {
    const el = document.getElementById('sp2o-draft-status');
    if (el) el.remove();
  }

  const backfillResultHandlers = [];

  // 接收 background 的存檔結果，在頁面內顯示
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'SAVE_RESULT') {
      // 發佈後草稿已刪除，狀態列一併收掉。補存是背景行為，與目前的 composer
      // 無關：它的失敗通知不可以把使用者正在打字的草稿狀態列清掉。
      if (!message.backfill) hideDraftStatus();
      showToast(message.text, message.ok);
    }
    if (message && message.type === 'DRAFT_RESULT') {
      showDraftStatus(message.text, message.ok);
    }
    if (message && message.type === 'X_BACKFILL_RESULTS') {
      backfillResultHandlers.forEach((handler) => handler(message.posts));
    }
    // 同步回應，避免 background 誤判送達失敗而重複跳系統通知
    sendResponse({ ok: true });
  });

  // 訂閱 MAIN world interceptor 轉發的 API 回應。
  // kind 未指定時只收發文回應：舊版 interceptor 不送 kind，視為 create 才不會漏接。
  function onIntercept(platform, callback, kind = 'create') {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== 'sp2o-interceptor' || d.platform !== platform) return;
      if ((d.kind || 'create') !== kind) return;
      callback(d);
    });
  }

  // 解析 X 的 CreateTweet / CreateNoteTweet 回應
  function parseCreateTweet(responseText) {
    try {
      const json = JSON.parse(responseText);
      const data = json && json.data;
      if (!data) return null;

      const result = data.create_tweet?.tweet_results?.result
        || data.notetweet_create?.tweet_results?.result;
      return parseTweetResult(result);
    } catch (e) {
      return null;
    }
  }

  // 單則貼文的 tweet_results.result → 存檔用資料。
  // 發文回應與個人頁時間軸的每則貼文共用同一種結構，解析只留這一份。
  function parseTweetResult(result) {
    if (!result) return null;

    const tweet = result.tweet || result;
    const legacy = tweet.legacy || {};
    const user = tweet.core?.user_results?.result;
    const screenName = user?.legacy?.screen_name || user?.core?.screen_name || '';
    if (!tweet.rest_id || !screenName) return null;

    // 長推文的完整內容在 note_tweet
    const text = tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';
    const media = extractXMedia(tweet);

    let quoted = null;
    const quotedResult = tweet.quoted_status_result?.result;
    if (quotedResult) {
      const qt = quotedResult.tweet || quotedResult;
      const qUser = qt.core?.user_results?.result;
      const qScreen = qUser?.legacy?.screen_name || qUser?.core?.screen_name || 'unknown';
      quoted = {
        author: qScreen,
        authorName: qUser?.legacy?.name || qUser?.core?.name || qScreen,
        content: qt.note_tweet?.note_tweet_results?.result?.text || qt.legacy?.full_text || '',
        url: qt.rest_id ? `https://x.com/${qScreen}/status/${qt.rest_id}` : ''
      };
    }

    return {
      id: tweet.rest_id,
      author: screenName,
      url: `https://x.com/${screenName}/status/${tweet.rest_id}`,
      text: text,
      // 補存用：時間軸貼文不是「現在」發的，檔名與 frontmatter 都要用原始發佈時間
      createdAt: legacy.created_at || '',
      conversationId: legacy.conversation_id_str || tweet.rest_id,
      isRetweet: !!legacy.retweeted_status_result,
      replyToAuthor: legacy.in_reply_to_screen_name || '',
      replyTo: legacy.in_reply_to_status_id_str
        ? `https://x.com/${legacy.in_reply_to_screen_name || 'i'}/status/${legacy.in_reply_to_status_id_str}`
        : null,
      quoted: quoted,
      media: media
    };
  }

  // Sync only directly attached photos; videos and animated GIFs are intentionally skipped.
  function extractXMedia(tweet) {
    const legacy = tweet.legacy || {};
    const items = legacy.extended_entities?.media || legacy.entities?.media || [];
    const seen = new Set();

    return items.flatMap((item, index) => {
      const url = item.type === 'photo' && (item.media_url_https || item.media_url);
      if (!url || seen.has(url)) return [];
      seen.add(url);
      return [{
        url: url.replace(/^http:/, 'https:'),
        alt: item.ext_alt_text || `圖片 ${index + 1}`
      }];
    });
  }

  // 解析 Threads 發文 mutation 回應
  function parseThreadsCreate(responseText) {
    try {
      // Meta 的部分回應會加上 for(;;); 前綴
      const clean = responseText.replace(/^for\s*\(;;\);/, '');
      const json = JSON.parse(clean);
      const post = findThreadsPost(json, 0);
      if (!post) return null;

      const username = post.user?.username || '';
      const url = typeof post.permalink === 'string' && post.permalink
        ? post.permalink
        : (username && post.code)
          ? `https://www.threads.com/@${username}/post/${post.code}`
          : '';

      let text = post.caption?.text || '';
      if (!text) {
        const fragments = post.text_post_app_info?.text_fragments?.fragments;
        if (Array.isArray(fragments)) {
          text = fragments.map(f => f.plaintext || '').join('');
        }
      }

      const media = extractThreadsMedia(post);

      let quoted = null;
      const q = post.text_post_app_info?.share_info?.quoted_post;
      if (q) {
        const qUser = q.user?.username || 'unknown';
        quoted = {
          author: qUser,
          authorName: qUser,
          content: q.caption?.text || '',
          url: q.code ? `https://www.threads.com/@${qUser}/post/${q.code}` : ''
        };
      }

      if (!url && !text && media.length === 0) return null;
      return { url: url, text: text, replyTo: null, quoted: quoted, media: media };
    } catch (e) {
      return null;
    }
  }

  // Use image_versions2 for single images, carousels, and inline media;
  // do not treat video covers as photos.
  function extractThreadsMedia(post) {
    const linkedInlineMedia = post.text_post_app_info?.linked_inline_media;
    const items = [post, linkedInlineMedia].flatMap((container) => {
      if (!container) return [];
      if (Array.isArray(container.carousel_media) && container.carousel_media.length > 0) {
        return container.carousel_media;
      }

      const hasImage = Array.isArray(container.image_versions2?.candidates)
        && container.image_versions2.candidates.length > 0;
      const hasVideo = Array.isArray(container.video_versions)
        && container.video_versions.length > 0;
      return hasImage || hasVideo ? [container] : [];
    });
    const seen = new Set();

    return items.flatMap((item, index) => {
      if (Array.isArray(item.video_versions) && item.video_versions.length > 0) return [];

      const candidates = item.image_versions2?.candidates || [];
      const best = candidates
        .filter(candidate => candidate.url)
        .sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
      if (!best?.url || seen.has(best.url)) return [];
      seen.add(best.url);
      return [{
        url: best.url,
        alt: item.accessibility_caption || `圖片 ${index + 1}`
      }];
    });
  }

  // 深度搜尋回應 JSON 中的貼文物件。舊 GraphQL response 有 user.username；
  // 現行 media configure response 可能只保證 pk + code/permalink 與媒體欄位。
  // 主貼文一定比其內嵌的引用貼文先被走訪到
  function findThreadsPost(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return null;
    const hasIdentity = node.pk
      && (typeof node.code === 'string' || typeof node.permalink === 'string');
    const hasPostData = (node.user && typeof node.user.username === 'string')
      || node.caption
      || node.image_versions2
      || node.carousel_media
      || node.media_type;
    if (hasIdentity && hasPostData) {
      return node;
    }
    for (const key of Object.keys(node)) {
      const found = findThreadsPost(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  // ===== 發佈與草稿共用流程 =====
  // twitter.js 與 threads.js 共用同一套狀態機；平台檔只提供 DOM 擷取與按鈕偵測
  const DEBOUNCE_DELAY = 500;      // 草稿 debounce（毫秒）
  const API_WAIT_TIMEOUT = 8000;   // 等待發文 API 回應的時限（毫秒）
  const THREAD_WINDOW = 15000;     // 串文後續 API 回應的忽略時窗（毫秒）
  const OBSERVER_SCAN_DELAY = 150; // 合併同批 DOM mutation 再掃描輸入框（毫秒）
  const POST_PUBLISH_SETTLE_MS = 2000; // 發佈後 X 重建 editor 的 DOM 收尾時窗（毫秒）

  // config：platform、label、parseResponse(text)、
  //         getTextContent(source)（回傳單則字串或串文陣列）、
  //         getQuoted(source)／getReplyTo(source)（可省略）、
  //         getDraftInputs(source)（回傳已過濾至 composer 的輸入框）
  function createPublishPipeline(config) {
    const {
      platform, label, parseResponse, getTextContent, getQuoted, getReplyTo, getDraftInputs
    } = config;

    let debounceTimer = null;
    let pendingPost = null;
    let pendingTimer = null;
    let lastFlushAt = 0;
    let draftActivityNotified = false;
    let draftSessionSequence = 0;
    let activeDraftSessionId = null;
    let publishedDraftSessionId = null;
    let publishedDraftSessionAt = 0;
    let draftSessionInputs = new WeakSet();
    // 8 秒備援先送出後保留原始資料；遲到的 API 回應用它重送同一筆以修正 url/media
    let fallbackBase = null;

    function readComposerContent(source) {
      const captured = getTextContent(source);
      if (Array.isArray(captured)) {
        const items = captured
          .map(item => String(item || '').trim())
          .filter(Boolean);
        return {
          content: items.join('\n\n---\n\n'),
          thread: items.length > 1 ? items : null
        };
      }
      return { content: String(captured || '').trim(), thread: null };
    }

    function startDraftSession() {
      draftSessionSequence++;
      activeDraftSessionId = [
        platform,
        Date.now().toString(36),
        draftSessionSequence.toString(36)
      ].join(':');
      draftSessionInputs = new WeakSet();
      return activeDraftSessionId;
    }

    function getDraftSessionId(input, forceNew) {
      if (forceNew
        || !activeDraftSessionId
        || (activeDraftSessionId === publishedDraftSessionId
          && input
          && !draftSessionInputs.has(input))) {
        startDraftSession();
      }
      if (input) draftSessionInputs.add(input);
      return activeDraftSessionId;
    }

    function prepareDraftEvent(input) {
      if (activeDraftSessionId === publishedDraftSessionId && input) {
        const isKnownInput = draftSessionInputs.has(input);
        const isPublishSettling = platform === 'x'
          && publishedDraftSessionAt
          && Date.now() - publishedDraftSessionAt <= POST_PUBLISH_SETTLE_MS;
        // X 發佈後會用新 editor node 重建尚在移除中的串文。這些 node 雖不在
        // WeakSet，仍屬同一次發佈的 DOM 收尾，不能另開 session 把草稿寫回。
        if (!isKnownInput && !isPublishSettling) {
          getDraftSessionId(input, false);
          return true;
        }
        draftSessionInputs.add(input);
        const text = String(input.innerText || input.textContent || '').trim();
        // X 清空同一個 inline composer 時，下一次輸入應建立新 session。
        if (!text) {
          activeDraftSessionId = null;
          publishedDraftSessionId = null;
          publishedDraftSessionAt = 0;
          draftSessionInputs = new WeakSet();
        }
        return false;
      }
      getDraftSessionId(input, false);
      return true;
    }

    function notifyDraftActivity() {
      if (platform !== 'x' || draftActivityNotified) return;
      draftActivityNotified = true;
      sendRequest({ type: 'CANCEL_X_BACKFILL_SCAN' }).catch(() => {});
    }

    function sendDraftSnapshot(captured, timestamp, draftSessionId) {
      if (!captured.content) return;
      sendMessage({
        type: 'SAVE_DRAFT',
        data: {
          content: captured.content,
          thread: captured.thread,
          platform: platform,
          timestamp: timestamp,
          draftSessionId: draftSessionId
        }
      });
      console.log(LOG, label + ': 已發送草稿');
    }

    // 發佈觸發（點擊/鍵盤）：擷取內容後等發文 API 回應補上正確資料
    function capturePost(source) {
      const captured = readComposerContent(source);
      if (!captured.content) {
        console.log(LOG, label + ': 貼文內容為空，跳過');
        return;
      }

      notifyDraftActivity();
      clearTimeout(debounceTimer);
      const timestamp = new Date().toISOString();
      const forceNewSession = activeDraftSessionId === publishedDraftSessionId;
      if (forceNewSession) startDraftSession();
      (getDraftInputs(source) || []).forEach((input) => getDraftSessionId(input, false));
      const draftSessionId = getDraftSessionId(null, false);
      pendingPost = {
        content: captured.content,
        thread: captured.thread,
        quoted: getQuoted ? getQuoted(source) : null,
        replyTo: getReplyTo ? getReplyTo(source) : null,
        timestamp: timestamp,
        draftSessionId: draftSessionId
      };
      // 使用者可能在最後一次 input 的 500ms debounce 到期前就按下發佈。
      // 先把按下按鈕當下的完整快照送出，API 攔截或頁面切換失敗時才不會
      // 只留下上一版未完成的草稿。
      sendDraftSnapshot(captured, timestamp, draftSessionId);
      fallbackBase = null;
      console.log(LOG, label + ': 已擷取貼文內容，等待發文 API 回應...');

      // 備援：時限內沒攔截到發文 API 回應，就用 DOM 資料直接送出
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        console.log(LOG, label + ': 未攔截到 API 回應，使用備援資料送出');
        flushPending(null);
      }, API_WAIT_TIMEOUT);
    }

    // 組合 DOM 擷取內容與 API 回應，送出到 background
    function flushPending(api) {
      if (!pendingPost && !api) return;

      const base = pendingPost || { content: '', quoted: null, timestamp: new Date().toISOString() };
      const data = {
        // DOM 擷取的內容保留使用者輸入原文；沒有時用 API 回傳的正式文字
        content: base.content || (api ? api.text : ''),
        platform: platform,
        url: api ? api.url : window.location.href,
        timestamp: base.timestamp,
        draftSessionId: base.draftSessionId || null
      };

      const quoted = (api && api.quoted) || base.quoted;
      if (quoted) data.quoted = quoted;
      const replyTo = (api && api.replyTo) || base.replyTo;
      if (replyTo) data.replyTo = replyTo;
      if (api && api.media?.length) data.media = api.media;
      if (base.thread?.length > 1) data.thread = base.thread;

      pendingPost = null;
      clearTimeout(pendingTimer);

      if (!data.content && !data.media?.length) return;
      lastFlushAt = Date.now();
      fallbackBase = api ? null : base;

      sendMessage({ type: 'PUBLISH_DRAFT', data: data });
      publishedDraftSessionId = data.draftSessionId;
      publishedDraftSessionAt = Date.now();
      console.log(LOG, label + ': 已發送貼文內容', data.url);
    }

    // 攔截發文 API 回應：發佈成功當下即取得正確 URL、引用與圖片資訊
    onIntercept(platform, (msg) => {
      const api = parseResponse(msg.responseText);
      if (!api) return;

      // 沒有進行中的發佈時一律不自動建檔，避免頁面上任何腳本偽造 API 回應
      // 觸發未經授權的存檔；依情境分流，順序不可調換。這類回應安靜忽略，
      // 不再顯示需手動確認的即時漏存提醒。
      if (!pendingPost) {
        if (fallbackBase && Date.now() - lastFlushAt < THREAD_WINDOW) {
          // 備援已先送出（例如網路慢、API 回應晚於 8 秒時限）：
          // 沿用原 timestamp 重送，background 會產生同一檔名覆寫，修正備援存檔的 url/media
          console.log(LOG, label + ': 收到遲到的 API 回應，修正備援存檔', api.url);
          pendingPost = fallbackBase;
          fallbackBase = null;
          flushPending(api);
        } else if (fallbackBase || Date.now() - lastFlushAt < THREAD_WINDOW) {
          // 串文的後續回應，或備援存檔後遲到超過時窗的回應：
          // 內容已經在 Vault 裡，不需要補救，也不能再建一個檔
          console.log(LOG, label + ': 忽略未對應發佈的 API 回應', api.url);
        } else {
          console.log(LOG, label + ': 忽略沒有對應送出動作的 API 回應', api.url);
        }
        return;
      }

      console.log(LOG, label + ': 攔截到發文 API 回應', api.url);
      flushPending(api);
    });

    // 草稿觸發（debounce 到期或 blur）：擷取內容送 background 暫存
    function captureDraft(input) {
      const draftSessionId = getDraftSessionId(input, false);
      if (draftSessionId === publishedDraftSessionId) return;
      const captured = readComposerContent(input);
      if (!captured.content) return;

      notifyDraftActivity();
      sendDraftSnapshot(captured, new Date().toISOString(), draftSessionId);
    }

    // 草稿自動存檔監聽：輸入框是動態產生的，用 MutationObserver 掛監聽
    function setupDraftListener() {
      const attachedInputs = new WeakSet();
      let scanTimer = null;

      function attachAll() {
        (getDraftInputs() || []).forEach((input) => {
          if (attachedInputs.has(input)) return;
          attachedInputs.add(input);

          const scheduleDraftCapture = () => {
            if (!prepareDraftEvent(input)) return;
            notifyDraftActivity();
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => captureDraft(input), DEBOUNCE_DELAY);
          };

          input.addEventListener('input', scheduleDraftCapture);
          // X 貼上純文字或富文字時不保證會再送標準 input；paste 發生在
          // DOM 更新前，因此沿用 500ms debounce，等編輯器完成內容正規化後再讀。
          input.addEventListener('paste', scheduleDraftCapture, true);
          // 離開輸入框時立即存一次草稿
          input.addEventListener('blur', () => {
            if (!prepareDraftEvent(input)) return;
            clearTimeout(debounceTimer);
            captureDraft(input);
          });

          console.log(LOG, label + ': 已附加草稿監聽到輸入框');
        });
      }

      // SPA 高頻更新下合併同批 mutation 再掃描，避免每次 mutation 都做全頁查詢
      const observer = new MutationObserver(() => {
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
          scanTimer = null;
          attachAll();
        }, OBSERVER_SCAN_DELAY);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      attachAll();
      console.log(LOG, label + ': 草稿監聽已啟動');
    }

    // 初始化：DOM 就緒後啟動平台事件監聽與草稿監聽
    function init(setupListener) {
      console.log(LOG, label + ': 初始化中...', window.location.href);
      const start = () => {
        setupListener();
        setupDraftListener();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    }

    return { capturePost, captureDraft, init };
  }

  // ===== 手機貼文補存 =====
  // 手機 app 發的文攔不到發文 API。但之後在桌面瀏覽自己的個人頁時，
  // 那些貼文會出現在時間軸回應裡，於是能比對 Vault、提示補存。

  // 只補近期貼文：舊筆記用的是沒有時分的舊檔名格式，比對不到會重複建檔；
  // 而且個人頁往下捲會一路回傳歷史貼文，不該把整個帳號史都撈進來。
  const BACKFILL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  const BACKFILL_DEBOUNCE = 1500;
  // 同一 conversation 內相隔超過這個時間就先拆成不同補存候選，讓 Vault 能逐則
  // 比對缺漏；使用者確認補存後，background 再把三日內的自回覆合併回母筆記。
  const BACKFILL_THREAD_GAP_MS = 10 * 60 * 1000;

  // 遞迴收集時間軸裡的 tweet_results.result。
  // 引用與轉推分別掛在 quoted_status_result／retweeted_status_result 底下，
  // 不是 tweet_results，所以不會被誤收成候選。
  //
  // 深度上限只是防爆堆疊，不該拿來當過濾條件：一般貼文在
  // entries[].content.itemContent（約 12 層），但回覆包在對話模組裡，
  // 路徑是 entries[].content.items[].item.itemContent（約 15 層）。
  // 上限訂太低會讓「回覆」分頁一則都收不到。
  const MAX_TIMELINE_DEPTH = 24;

  function collectTweetResults(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_TIMELINE_DEPTH) return out;
    if (Array.isArray(node)) {
      node.forEach((item) => collectTweetResults(item, out, depth + 1));
      return out;
    }
    if (node.tweet_results && node.tweet_results.result) out.push(node.tweet_results.result);
    Object.keys(node).forEach((key) => collectTweetResults(node[key], out, depth + 1));
    return out;
  }

  // 解析個人頁時間軸回應，只留下 ownAuthor 本人撰寫、非轉推的貼文
  function parseUserTweets(responseText, ownAuthor) {
    try {
      const json = JSON.parse(responseText);
      const seen = new Set();
      const posts = [];

      collectTweetResults(json, [], 0).forEach((result) => {
        const post = parseTweetResult(result);
        if (!post || post.isRetweet || !post.createdAt) return;
        if (!ownAuthor || post.author.toLowerCase() !== ownAuthor.toLowerCase()) return;
        if (seen.has(post.id)) return;
        seen.add(post.id);
        posts.push(post);
      });

      return posts;
    } catch (e) {
      return null;
    }
  }

  // 依 conversation 分組，讓一則串文對應一個檔案（與正常發佈的行為一致）
  function buildBackfillNotes(posts, platform) {
    const groups = new Map();
    posts.forEach((post) => {
      const key = post.conversationId || post.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(post);
    });

    const notes = [];
    groups.forEach((items) => {
      // snowflake ID 遞增即發文順序；長度不同時短的較早
      items.sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
      splitByThreadGap(items).forEach((run) => {
        const note = buildBackfillNote(run, platform);
        if (note) notes.push(note);
      });
    });
    return notes;
  }

  // 串文是一次打完的（發佈端的時窗只有 15 秒）。事後追加的回覆必須先各自比對：
  // 若此處先合成一個候選，母筆記已存在時，後續回覆會跟著母 URL 被判定為已存而漏掉。
  // SAVE_POST 寫入階段仍會依三日規則合併，因此這裡的切分不代表最後一定分成兩份檔案。
  function splitByThreadGap(items) {
    const runs = [];
    items.forEach((post) => {
      const current = runs[runs.length - 1];
      const last = current && current[current.length - 1];
      const gap = last ? new Date(post.createdAt) - new Date(last.createdAt) : 0;
      if (!current || !(gap <= BACKFILL_THREAD_GAP_MS)) runs.push([post]);
      else current.push(post);
    });
    return runs;
  }

  function buildBackfillNote(items, platform) {
    const first = items[0];
    const published = new Date(first.createdAt);
    if (isNaN(published.getTime())) return null;
    if (Date.now() - published.getTime() > BACKFILL_MAX_AGE_MS) return null;

    const texts = items.map((item) => item.text).filter(Boolean);
    const media = items.flatMap((item) => item.media || []);
    if (!texts.length && !media.length) return null;

    const data = {
      content: texts.join('\n\n---\n\n'),
      platform: platform,
      url: first.url,
      timestamp: published.toISOString()
    };
    if (texts.length > 1) {
      data.thread = texts;
      // 手機補存能從時間軸取得串文每一則的正式 URL；保留它們，讓三日內
      // 回覆第二則以後的貼文時，background 仍能找到同一份母筆記。
      data.threadUrls = items.map(item => item.url).filter(Boolean);
    }
    if (first.quoted) data.quoted = first.quoted;
    if (first.replyTo) data.replyTo = first.replyTo;
    if (media.length) data.media = media;
    return data;
  }

  // 主動掃描的 content script 端：只負責判斷「現在可以掃嗎」。
  //
  // 重播用的網址與標頭都由 MAIN world 就地擷取，這裡不碰也不保存——X 的請求
  // 簽章綁定單次請求且很快失效，存起來沒有意義。所以掃描只能在頁面剛送出
  // 該端點的真實請求之後立刻進行。
  //
  // 只在使用者自己的個人頁觸發：逛別人的個人頁時那個請求查的是別人的時間軸，
  // 重播等於拿使用者的憑證去翻別人的貼文。
  const SCAN_RETRY_MS = 3000;
  const SCAN_POLL_ATTEMPTS = 20;

  function createTimelineScanner(platform, label, operations, getOwnAuthor) {
    // 已完成的端點由 MAIN world 回報；沒回報過的都還可以再試
    const done = new Set();
    const lastRequest = new Map();

    onIntercept(platform, (msg) => {
      (msg.operations || []).forEach((operation) => done.add(operation));
    }, 'scanned');

    function onOwnProfile(ownAuthor) {
      const first = location.pathname.replace(/^\//, '').split('/')[0].toLowerCase();
      return !!ownAuthor && first === ownAuthor.toLowerCase();
    }

    function requestScan(ownAuthor, operation) {
      if (!onOwnProfile(ownAuthor)) return;
      if (!operations.includes(operation) || done.has(operation)) return;
      // 每頁重播回應都會再觸發一次，這裡節流才不會洗頻
      const now = Date.now();
      if (now - (lastRequest.get(operation) || 0) < SCAN_RETRY_MS) return;
      lastRequest.set(operation, now);
      console.log(LOG, label + ': 請求主動掃描 ' + operation);
      try {
        window.postMessage(
          { source: 'sp2o-content', action: 'scan', operations: [operation] },
          location.origin
        );
      } catch (e) { /* ignore */ }
    }

    // interceptor 在 document_start、這支 content script 在 document_idle。
    // 直接開個人頁網址時，頁面的時間軸請求可能早於這裡註冊監聽，那則轉發訊息
    // 就沒人接到，於是完全不會觸發掃描。所以載入後主動問一次：MAIN world
    // 擷取到什麼就掃什麼。側邊欄還沒渲染時認不出帳號，所以要重試。
    function pollForScan(attempt) {
      const ownAuthor = getOwnAuthor();
      if (ownAuthor) operations.forEach((operation) => requestScan(ownAuthor, operation));
      if (attempt >= SCAN_POLL_ATTEMPTS) return;
      if (operations.every((operation) => done.has(operation))) return;
      setTimeout(() => pollForScan(attempt + 1), 1000);
    }
    pollForScan(0);

    return requestScan;
  }

  function createBackfillWatcher({ platform, label, parseTimeline, getOwnAuthor, scanOperations }) {
    // 同一則貼文只比對一次：個人頁每捲一次都會再送一批時間軸回應
    const checkedIds = new Set();
    const missingNotes = new Map();
    let pending = [];
    let debounceTimer = null;
    let scanCompleted = false;
    let scanRolePromise = null;

    function receiveRelayedResults(posts) {
      if (!Array.isArray(posts)) return;
      posts.forEach((data) => {
        if (data && data.url && data.timestamp) missingNotes.set(data.url, data);
      });
      autoSaveMissing();
    }
    if (platform === 'x') backfillResultHandlers.push(receiveRelayedResults);

    function getScanRole() {
      if (platform !== 'x') return Promise.resolve({ scanTab: false });
      if (scanRolePromise) return scanRolePromise;
      const ownAuthor = getOwnAuthor();
      if (!ownAuthor) return Promise.resolve(null);
      scanRolePromise = sendRequest({
        type: 'ENSURE_X_BACKFILL_SCAN',
        author: ownAuthor
      }).then((response) => response || { scanTab: false });
      return scanRolePromise;
    }

    function requestAutomaticScan(attempt) {
      if (platform !== 'x') return;
      if (getOwnAuthor()) {
        getScanRole().then((role) => {
          if (role?.opened) console.log(LOG, label + ': 已啟動背景補存掃描');
        });
        return;
      }
      if (attempt < SCAN_POLL_ATTEMPTS) {
        setTimeout(() => requestAutomaticScan(attempt + 1), 1000);
      }
    }

    async function relayBackgroundScanResults() {
      if (platform !== 'x' || !scanCompleted) return false;
      const role = await getScanRole();
      if (!role?.scanTab) return false;
      const response = await sendRequest({
        type: 'X_BACKFILL_RESULTS',
        posts: Array.from(missingNotes.values())
      });
      if (response?.relayed) {
        missingNotes.clear();
        return true;
      }
      return false;
    }

    // 比對 Vault 後直接寫入，不再要求人工確認。
    //
    // 攔截訊息來自 MAIN world postMessage，沒有 origin/token 檢查，因此這條路徑
    // 的防線改由前段把關：只在本人個人頁掃描（onOwnProfile）、只收 ownAuthor 本人
    // 的非轉推貼文（parseUserTweets）、14 天內（BACKFILL_MAX_AGE_MS）、且必須先經
    // FIND_MISSING_POSTS 與 Vault 比對確認尚未存在。寫入時另有 escapeYaml／
    // escapeMarkdown 中和注入。
    //
    // 用 sendRequest 而非 sendMessage：要等 background 回報實際結果才報數字，
    // 不做樂觀宣告。
    async function autoSaveMissing() {
      if (!missingNotes.size) return;
      const notes = Array.from(missingNotes.values());
      missingNotes.clear();

      const results = await Promise.all(notes.map(
        (data) => sendRequest({ type: 'SAVE_POST', data: data, silent: true })
      ));
      const saved = results.filter((result) => result?.ok).length;
      const failed = results.length - saved;

      console.log(LOG, label + ': 自動補存 ' + saved + ' 則，失敗 ' + failed + ' 則');
      if (!saved && !failed) return;
      if (failed) showToast(`已補存 ${saved} 則，${failed} 則失敗`, false);
      else showToast(`已補存 ${saved} 則貼文`, true);
    }

    async function checkPending() {
      const notes = buildBackfillNotes(pending, platform);
      pending = [];
      if (notes.length) {
        const response = await sendRequest({ type: 'FIND_MISSING_POSTS', posts: notes });
        if (!response || !response.ok || !Array.isArray(response.missing)) {
          console.log(LOG, label + ': 補存比對沒有結果', response && response.error);
          return;
        }
        console.log(LOG, label + ': 比對 ' + notes.length + ' 篇，未存 ' + response.missing.length + ' 篇');

        const missingUrls = new Set(response.missing);
        notes.forEach((data) => {
          if (missingUrls.has(data.url)) missingNotes.set(data.url, data);
        });
      }

      if (await relayBackgroundScanResults()) return;
      await autoSaveMissing();
    }

    let reportedNoAuthor = false;
    const requestScan = scanOperations && scanOperations.length
      ? createTimelineScanner(platform, label, scanOperations, getOwnAuthor)
      : null;

    onIntercept(platform, (msg) => {
      const primaryOperation = scanOperations && scanOperations[0];
      if (!primaryOperation || !(msg.operations || []).includes(primaryOperation)) return;
      scanCompleted = true;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkPending().catch((error) => {
          console.log(LOG, label + ': 補存結果傳送失敗', error.message);
        });
      }, BACKFILL_DEBOUNCE);
    }, 'scanned');

    onIntercept(platform, (msg) => {
      const ownAuthor = getOwnAuthor();
      // 認不出登入帳號就不動作，寧可不提示也不要把別人的貼文當成自己的
      if (!ownAuthor) {
        if (!reportedNoAuthor) {
          reportedNoAuthor = true;
          console.log(LOG, label + ': 認不出登入帳號，略過補存偵測');
        }
        return;
      }

      // 收到個人頁時間軸回應＝頁面剛送出過一次真實請求，簽章還新鮮，可以翻頁了
      if (requestScan) requestScan(ownAuthor, msg.operation);

      const posts = parseTimeline(msg.responseText, ownAuthor);
      console.log(LOG, label + ': 時間軸回應，解析到 ' + ((posts && posts.length) || 0) + ' 則自己的貼文');
      if (!posts || !posts.length) return;

      const fresh = posts.filter((post) => !checkedIds.has(post.id));
      if (!fresh.length) return;
      fresh.forEach((post) => checkedIds.add(post.id));
      pending = pending.concat(fresh);

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        checkPending().catch((error) => {
          console.log(LOG, label + ': 補存比對失敗', error.message);
        });
      }, BACKFILL_DEBOUNCE);
    }, 'timeline');

    // 監聽器現在才真正就緒；要求 document_start 的 interceptor 重送在這之前
    // 已收到的 TweetDetail／UserTweets 回應，避免直接開貼文頁時靜默漏掉。
    try {
      window.postMessage({ source: 'sp2o-content', action: 'timeline-ready' }, location.origin);
    } catch (e) { /* ignore */ }

    requestAutomaticScan(0);
    console.log(LOG, label + ': 手機貼文補存監聽已啟動');
  }

  return {
    sendMessage, sendRequest, showToast, onIntercept,
    parseCreateTweet, parseThreadsCreate, parseUserTweets, buildBackfillNotes,
    createPublishPipeline, createBackfillWatcher
  };
})();
