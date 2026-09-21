// MAIN world 攔截器：掛勾頁面的 fetch / XHR，攔截「發文」API 的回應，
// 轉發給 content script（ISOLATED world）。存檔因此能拿到平台官方回傳的
// 貼文 ID / URL / 內容，不需再從 DOM 猜測。
(function () {
  'use strict';

  // 判斷是否為發文請求：回傳平台代號或 null
  function matchCreateRequest(url, friendlyName) {
    if (/\/graphql\/[^/?]+\/Create(Note)?Tweet/i.test(url)) return 'x';
    // Threads web publishing uses Instagram media configure endpoints rather than GraphQL.
    // The response contains the canonical post data and downloadable image candidates.
    if (/\/api\/v1\/media\/configure_text_(?:only_post|post_app_(?:feed|sidecar))\/?(?:[?#]|$)/i.test(url)) {
      return 'threads';
    }
    if (url.includes('/graphql') && /create.*post|post.*create/i.test(friendlyName || '')) {
      return 'threads';
    }
    return null;
  }

  // 判斷是否為「可能含有自己既有貼文」的查詢：手機 app 發的文攔不到發文 API，
  // 只能在之後瀏覽這些頁面時，從回應裡把漏存的貼文找回來。
  //
  // TweetDetail（開啟單則貼文頁）是最可靠的一條：個人頁的「貼文」分頁不含
  // 回覆別人的貼文，而「回覆」分頁得一路捲到對的位置才會載入到；直接開貼文
  // 網址則是一次請求就拿到那則貼文，補存哪一則由使用者決定。
  function matchTimelineRequest(url) {
    if (/\/graphql\/[^/?]+\/UserTweets(AndReplies)?/i.test(url)) return 'x';
    if (/\/graphql\/[^/?]+\/TweetDetail/i.test(url)) return 'x';
    reportUnmatchedUserQuery(url);
    return null;
  }

  // X 改版時端點會換名字，而漏接是「靜默沒反應」，從外面完全查不出來。
  // 這裡把沒比對到的個人頁查詢印出來（每個名稱只印一次），下次要對照時有據可查。
  const reportedQueries = new Set();
  function reportUnmatchedUserQuery(url) {
    try {
      if (!url.includes('/graphql/')) return;
      const operation = url.split('/graphql/')[1].split('?')[0].split('/').pop();
      if (!/^User/i.test(operation) || reportedQueries.has(operation)) return;
      reportedQueries.add(operation);
      console.log('[順筆] 未比對的個人頁端點:', operation);
    } catch (e) { /* ignore */ }
  }

  // 從 URL 取出 GraphQL 操作名稱（.../graphql/<queryId>/<Operation>?...）
  function operationName(url) {
    try {
      if (!url.includes('/graphql/')) return '';
      return url.split('/graphql/')[1].split('?')[0].split('/').pop() || '';
    } catch (e) {
      return '';
    }
  }

  function headerValue(headers, name) {
    try {
      if (!headers) return '';
      if (typeof headers.get === 'function') return headers.get(name) || '';
      if (Array.isArray(headers)) {
        const hit = headers.find(h => String(h[0]).toLowerCase() === name);
        return hit ? hit[1] : '';
      }
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) return headers[key];
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  // Threads 的 friendly name 也會放在表單 body 的 fb_api_req_friendly_name
  function friendlyFromBody(body) {
    try {
      if (typeof body === 'string' && body.includes('fb_api_req_friendly_name=')) {
        return decodeURIComponent(body.split('fb_api_req_friendly_name=')[1].split('&')[0]);
      }
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.get('fb_api_req_friendly_name') || '';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  // interceptor 在 document_start、content script 在 document_idle。直接開貼文網址時，
  // TweetDetail 可能在 content script 開始監聽前就回來，所以先暫存少量時間軸訊息；
  // content script 宣告 ready 後重送一次，再清掉避免長期占用大型 response。
  const TIMELINE_BUFFER_LIMIT = 4;
  const bufferedTimelineMessages = [];
  let timelineConsumerReady = false;

  function emit(message) {
    window.postMessage(message, window.location.origin);
  }

  // kind 區分發文回應（create）與個人頁時間軸回應（timeline）：
  // 兩者結構不同、後續處理也不同，收端必須能分辨，不可混為一談
  function forward(platform, requestUrl, responseText, kind) {
    try {
      const message = {
        source: 'sp2o-interceptor',
        platform: platform,
        kind: kind,
        // content script 靠這個知道剛剛看到的是哪個端點，才知道要請求掃描哪一個
        operation: kind === 'timeline' ? operationName(requestUrl) : '',
        requestUrl: requestUrl,
        responseText: responseText
      };
      if (kind === 'timeline' && !timelineConsumerReady) {
        bufferedTimelineMessages.push(message);
        if (bufferedTimelineMessages.length > TIMELINE_BUFFER_LIMIT) {
          bufferedTimelineMessages.shift();
        }
      }
      emit(message);
    } catch (e) { /* ignore */ }
  }

  // --- 主動掃描 ---
  //
  // 純被動攔截有個天生的死角：回覆別人的貼文不會出現在個人頁的「貼文」分頁，
  // 而「回覆」分頁得一路捲到對的位置才會載入到——等於要使用者自己捲到底。
  // 所以這裡改成重播 X 自己的時間軸查詢並自動翻頁：使用者只要打開個人頁，
  // 就能把近期漏存的貼文（含回覆）全部找出來。全程唯讀，不送出任何內容。
  //
  // GraphQL 端點的 queryId 與 features 參數每次改版都會變、無法自己合成，
  // 只能從真實請求上擷取當範本。認證標頭只留在記憶體，不寫進 storage。

  // 實測（v2.7.1）：x-client-transaction-id 是必要的，少了它一律回 404。
  // 而且它綁定「這一次的請求」——換一個端點的簽章會被拒，同一個也只能重複用
  // 幾次就失效。所以重播只能沿用「剛剛那個請求」的網址與標頭，兩者都不合成，
  // 也不跨頁保存：沒有現成的請求可沿用時就不掃。
  const REPLAY_HEADERS = [
    'authorization', 'x-csrf-token', 'x-twitter-auth-type',
    'x-twitter-active-user', 'x-twitter-client-language', 'x-client-transaction-id'
  ];
  // 簽章用完就失效，所以改成「少次數、大批量」：一頁 100 則、最多 4 頁。
  // 實測第一頁常常只回游標沒有貼文，真正的內容從第二頁開始。
  const SCAN_MAX_PAGES = 4;
  const SCAN_PAGE_COUNT = 100;
  const SCAN_PAGE_DELAY = 800;

  let scanning = false;
  // operation → 該次請求的網址與標頭（含只能用幾次的簽章），僅存在記憶體
  const liveRequests = new Map();

  function scanLog() {
    console.log.apply(console, ['[順筆]'].concat(Array.prototype.slice.call(arguments)));
  }

  // 時間軸 GET 命中時，把網址與標頭一起留下來給重播用
  function captureRequest(url, lookup) {
    const operation = operationName(url);
    if (!/^UserTweets(AndReplies)?$/i.test(operation)) return;
    if (!validTemplate(url)) return;

    const headers = {};
    REPLAY_HEADERS.forEach((name) => {
      const value = lookup(name);
      if (value) headers[name] = value;
    });
    if (!headers.authorization || !headers['x-client-transaction-id']) return;
    liveRequests.set(operation, { url: url, headers: headers });
  }

  // 網址雖然來自頁面自己的請求，重播時仍會帶上認證標頭，
  // 所以照樣限定本站的 UserTweets(AndReplies) 端點才動作。
  function validTemplate(url) {
    try {
      const parsed = new URL(String(url), window.location.origin);
      if (parsed.origin !== window.location.origin) return null;
      if (!/^(\/i\/api)?\/graphql\/[^/]+\/UserTweets(AndReplies)?$/.test(parsed.pathname)) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function withCursor(template, cursor) {
    const parsed = validTemplate(template);
    if (!parsed) return '';
    try {
      const variables = JSON.parse(parsed.searchParams.get('variables') || '{}');
      if (cursor) variables.cursor = cursor;
      else delete variables.cursor;
      variables.count = SCAN_PAGE_COUNT;
      parsed.searchParams.set('variables', JSON.stringify(variables));
      return parsed.href;
    } catch (e) {
      return '';
    }
  }

  // 下一頁的游標藏在 entries 裡的 TimelineTimelineCursor（cursorType: Bottom）
  function findBottomCursor(node, depth) {
    if (!node || typeof node !== 'object' || depth > 24) return '';
    const keys = Array.isArray(node) ? node.keys() : Object.keys(node);
    if (!Array.isArray(node) && node.cursorType === 'Bottom' && typeof node.value === 'string') {
      return node.value;
    }
    for (const key of keys) {
      const hit = findBottomCursor(node[key], depth + 1);
      if (hit) return hit;
    }
    return '';
  }

  async function scanOperation(operation, request) {
    let cursor = '';
    let forwarded = false;
    for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
      const url = withCursor(request.url, cursor);
      if (!url) return forwarded;

      let text = '';
      try {
        const response = await origFetch(url, { credentials: 'include', headers: request.headers });
        if (!response.ok) {
          // 簽章用完（404）最常見；被動攔截仍然照常運作，重新整理個人頁即可再掃
          scanLog(operation + ' 翻頁停在第 ' + (page + 1) + ' 頁 HTTP ' + response.status);
          return forwarded;
        }
        text = await response.text();
      } catch (error) {
        scanLog(operation + ' 翻頁失敗:', error.message);
        return forwarded;
      }

      forward('x', url, text, 'timeline');
      forwarded = true;

      let next = '';
      try {
        next = findBottomCursor(JSON.parse(text), 0);
      } catch (e) { /* ignore */ }
      // 翻到底時 X 會回同一個游標，重複就停，不要空轉
      if (!next || next === cursor) return forwarded;
      cursor = next;
      await new Promise((resolve) => setTimeout(resolve, SCAN_PAGE_DELAY));
    }
    return forwarded;
  }

  // 從個人頁點進「回覆」分頁時，UserTweets 會先送出、UserTweetsAndReplies 隨後才到。
  // 掃描期間抵達的請求必須排隊，不能因為「正在掃」就丟掉——丟掉的那個往往正是
  // UserTweetsAndReplies，而回覆別人的貼文只有它看得到，於是永遠補不回來。
  const scanQueue = [];

  function enqueueScan(operation) {
    if (scanQueue.indexOf(operation) !== -1) return;
    // 「回覆」分頁是「貼文」分頁的超集合，先掃它才不會被前面的排程拖到簽章過期
    if (/AndReplies$/.test(operation)) scanQueue.unshift(operation);
    else scanQueue.push(operation);
  }

  // content script 要知道哪些端點真的被掃了：它自己無從得知這裡擷取到什麼，
  // 沒有回報的話，它只能瞎猜而永遠不敢重試漏掉的端點
  function confirmScanned(operations) {
    try {
      window.postMessage({
        source: 'sp2o-interceptor',
        platform: 'x',
        kind: 'scanned',
        operations: operations
      }, window.location.origin);
    } catch (e) { /* ignore */ }
  }

  async function runScan(operations) {
    const available = operations.filter((operation) => liveRequests.has(operation));
    if (!available.length) return;
    available.forEach(enqueueScan);
    if (scanning) return;
    scanning = true;
    try {
      while (scanQueue.length) {
        const operation = scanQueue.shift();
        const request = liveRequests.get(operation);
        if (!request) continue;
        // 簽章會過期，用過就丟：下次要掃得等頁面再送出一次真實請求
        liveRequests.delete(operation);
        scanLog('開始掃描 ' + operation);
        // 真的拿到至少一頁後才回報完成。若簽章已過期，content script 必須保留
        // 重試資格，等頁面送出下一個新鮮的同端點請求。
        if (await scanOperation(operation, request)) confirmScanned([operation]);
      }
      scanLog('掃描完成');
    } finally {
      scanning = false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'sp2o-content') return;
    if (data.action === 'timeline-ready') {
      timelineConsumerReady = true;
      bufferedTimelineMessages.splice(0).forEach(emit);
      return;
    }
    if (data.action !== 'scan') return;
    // 掃描哪些端點由 content script 決定（它才知道現在是不是使用者自己的個人頁），
    // 但用哪個網址與標頭一律取自本地擷取，訊息內容不參與。
    runScan(Array.isArray(data.operations) ? data.operations : []);
  });

  // --- fetch hook ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    let method = 'GET';
    let friendly = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
      method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      friendly = headerValue((init && init.headers) || (input && input.headers), 'x-fb-friendly-name')
        || friendlyFromBody(init && init.body);
    } catch (e) { /* ignore */ }

    const promise = origFetch.apply(this, arguments);

    if (method === 'GET' && url.includes('/graphql/')) {
      const headers = (init && init.headers) || (input && input.headers);
      captureRequest(url, (name) => headerValue(headers, name));
    }

    // 發文走 POST，時間軸查詢走 GET
    const platform = method === 'POST'
      ? matchCreateRequest(url, friendly)
      : (method === 'GET' ? matchTimelineRequest(url) : null);

    if (platform) {
      const kind = method === 'POST' ? 'create' : 'timeline';
      promise.then((response) => {
        response.clone().text()
          .then((text) => forward(platform, url, text, kind))
          .catch(() => {});
      }).catch(() => {});
    }
    return promise;
  };

  // --- XHR hook（Meta 網站部分請求走 XHR）---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._sp2o = {
      method: String(method || '').toUpperCase(),
      url: String(url || ''),
      friendly: '',
      headers: {}
    };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._sp2o) {
      const key = String(name).toLowerCase();
      if (key === 'x-fb-friendly-name') this._sp2o.friendly = value;
      this._sp2o.headers[key] = value;
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const info = this._sp2o;
    if (info) {
      if (info.method === 'GET' && info.url.includes('/graphql/')) {
        captureRequest(info.url, (name) => info.headers[name] || '');
      }
      const friendly = info.friendly || friendlyFromBody(body);
      const platform = info.method === 'POST'
        ? matchCreateRequest(info.url, friendly)
        : (info.method === 'GET' ? matchTimelineRequest(info.url) : null);
      if (platform) {
        const kind = info.method === 'POST' ? 'create' : 'timeline';
        this.addEventListener('load', () => {
          try {
            // responseType 非 text 時讀取 responseText 會丟例外
            if (typeof this.responseText === 'string' && this.responseText) {
              forward(platform, info.url, this.responseText, kind);
            }
          } catch (e) { /* ignore */ }
        });
      }
    }
    return origSend.apply(this, arguments);
  };
})();
