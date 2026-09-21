// Twitter/X 平台擷取器：DOM 擷取與按鈕偵測；發佈/草稿流程共用 SP2O.createPublishPipeline
(function () {
  'use strict';

  const LOG = '[順筆]';
  const EDITOR_SELECTOR = '[data-testid^="tweetTextarea_"][contenteditable="true"]';

  // 檢查是否是最終的發文按鈕
  function isPostButton(element) {
    if (!element) return false;

    // 優先檢查 data-testid（最可靠）
    const testId = element.getAttribute('data-testid') || '';
    if (testId === 'tweetButton' || testId === 'tweetButtonInline') {
      console.log(LOG, 'Twitter: 偵測到發佈按鈕 (via testid)', testId);
      return true;
    }

    const text = element.textContent?.trim().toLowerCase() || '';
    const ariaLabel = element.getAttribute('aria-label')?.trim().toLowerCase() || '';

    // 精確匹配發文按鈕文字（data-testid 才是主要偵測，這裡只是備援）
    // 不放 'reply'、'貼文' 等泛用詞，避免點別處按鈕時誤存
    const exactKeywords = [
      'post', 'post all',
      '發佈', '全部發佈', '發布', '全部發布'
    ];

    const isMatch = exactKeywords.some(keyword =>
      text === keyword || ariaLabel === keyword
    );

    if (isMatch) {
      console.log(LOG, 'Twitter: 偵測到發佈按鈕', text);
    }

    return isMatch;
  }

  // 取得輸入框的文字內容（支援串文多則）
  function getTextContent() {
    // 有發文 dialog 時限定在 dialog 內找，避免同時抓到時間軸上的內嵌輸入框
    const scope = document.querySelector('[role="dialog"]') || document;
    const inputs = scope.querySelectorAll(EDITOR_SELECTOR);

    if (!inputs || inputs.length === 0) {
      console.log(LOG, 'Twitter: 找不到輸入框');
      return null;
    }

    const texts = [];
    // 同一個編輯器可能在 DOM 出現兩份，用 data-testid 去重；
    // 不能用文字內容去重：串文中兩則相同文字（如都是 emoji）會被誤刪一則
    const seenEditors = new Set();

    inputs.forEach((input) => {
      const editorId = input.getAttribute('data-testid') || '';
      if (seenEditors.has(editorId)) return;

      let text = '';
      if (input.innerText) {
        text = input.innerText.trim();
      } else if (input.textContent) {
        text = input.textContent.trim();
      }

      // 過濾 placeholder：直接比對編輯器內 placeholder 元素的文字（不分語言）
      const placeholderEl = input.querySelector('.public-DraftEditorPlaceholder-root');
      if (placeholderEl && text === placeholderEl.innerText?.trim()) {
        text = '';
      }
      const isPlaceholder = text === '有什麼新鮮事？' || text === "What's happening?" || text === '';

      if (text && !isPlaceholder && text !== '\n') {
        seenEditors.add(editorId);
        texts.push(text);
      }
    });

    if (texts.length === 0) {
      console.log(LOG, 'Twitter: 所有輸入框都是空的');
      return null;
    }

    console.log(LOG, `Twitter: 擷取到 ${texts.length} 則內容`);
    return texts;
  }

  // 擷取引用推文資訊（DOM 備援；正式資料以攔截到的發文 API 回應為準）
  function getQuotedTweet() {
    const dialog = document.querySelector('[role="dialog"]');
    const composer = dialog
      || document.querySelector('[data-testid="tweetTextarea_0"]')?.closest('[data-testid="cellInnerDiv"]');
    if (!composer) return null;

    const quoteContainer = composer.querySelector('[data-testid="quoteTweet"]')
      || composer.querySelector('[data-testid="quotedTweet"]')
      || composer.querySelector('[data-testid="card.wrapper"]');
    if (!quoteContainer) return null;

    // 作者
    const nameText = quoteContainer.querySelector('[data-testid="User-Name"]')?.textContent || '';
    const authorHandle = nameText.match(/@([a-zA-Z0-9_]+)/)?.[1] || 'unknown';
    const authorName = nameText.split('@')[0]?.trim() || authorHandle;

    // 內容
    const content = quoteContainer.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '';

    // 連結
    let url = '';
    const statusLink = quoteContainer.querySelector('a[href*="/status/"]');
    if (statusLink) {
      const href = statusLink.getAttribute('href') || '';
      url = href.startsWith('http') ? href : `https://x.com${href}`;
    }

    if (!content && authorHandle === 'unknown') return null;

    console.log(LOG, 'Twitter: 偵測到引用推文 (DOM)', authorHandle);
    return { author: authorHandle, authorName: authorName, content: content, url: url };
  }

  // 被回覆的貼文（DOM 備援；正式資料以攔截到的發文 API 回應為準）。
  // 沒有這個備援時，8 秒備援先送出的回覆會缺 replyTo，background 就接不回母筆記。
  //
  // 抓不到一律回 null：把貼文合併進錯的筆記比不合併更糟。
  function getReplyTo(source) {
    const dialog = source?.closest?.('[role="dialog"]') || null;

    // 貼文頁下方的 inline 回覆框：頁面網址本身就是被回覆的貼文
    if (!dialog) {
      const match = String(window.location.href || '')
        .match(/^https:\/\/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
      return match ? `https://x.com/${match[1]}/status/${match[2]}` : null;
    }

    // dialog 可能只是一般發文，不能用頁面網址猜；只認 dialog 內顯示的母貼文
    const parent = dialog.querySelector('[data-testid="tweet"]');
    const href = parent?.querySelector('a[href*="/status/"]')?.getAttribute('href') || '';
    const path = href.match(/\/([^/?#]+)\/status\/(\d+)/);
    return path ? `https://x.com/${path[1]}/status/${path[2]}` : null;
  }

  // 登入帳號：時間軸回應裡別人的貼文不該被當成自己的作品補存。
  // 只讀側邊欄的個人頁連結，不做全文件搜尋。
  function getOwnAuthor() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = link ? link.getAttribute('href') || '' : '';
    return href.replace(/^\//, '').split('/')[0] || '';
  }

  const pipeline = SP2O.createPublishPipeline({
    platform: 'x',
    label: 'Twitter',
    parseResponse: SP2O.parseCreateTweet,
    getTextContent: getTextContent,
    getQuoted: getQuotedTweet,
    getReplyTo: getReplyTo,
    getDraftInputs: () => document.querySelectorAll(EDITOR_SELECTOR)
  });

  // 手機 app 發的文攔不到發文 API。一般 X 頁面會由 background 暫時開啟本人
  // replies 分頁取得時間軸；本來就在個人頁時則直接沿用目前的 API 回應。
  // UserTweetsAndReplies（「回覆」分頁）不可省略：回覆別人的貼文不會出現在
  // UserTweets（「貼文」分頁）裡，少了它那些貼文永遠補不回來。
  SP2O.createBackfillWatcher({
    platform: 'x',
    label: 'Twitter',
    parseTimeline: SP2O.parseUserTweets,
    getOwnAuthor: getOwnAuthor,
    scanOperations: ['UserTweetsAndReplies', 'UserTweets']
  });

  // 設定事件監聽
  function setupListener() {
    document.addEventListener('click', (e) => {
      // 方法 1：直接用 data-testid 找發文按鈕（最可靠）
      const tweetButton = e.target.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');

      if (tweetButton) {
        // 確認按鈕沒有被禁用
        if (tweetButton.getAttribute('aria-disabled') === 'true') {
          console.log(LOG, 'Twitter: 按鈕已禁用，跳過');
          return;
        }

        console.log(LOG, 'Twitter: 偵測到發佈按鈕點擊 (via testid)');
        pipeline.capturePost();
        return;
      }

      // 方法 2：用文字內容匹配（備用）
      const genericButton = e.target.closest('[role="button"]');
      if (genericButton && isPostButton(genericButton)) {
        if (genericButton.getAttribute('aria-disabled') === 'true') {
          return;
        }
        pipeline.capturePost();
      }
    }, true);

    // 鍵盤發文（Cmd/Ctrl+Enter）：舊版只偵測點擊，鍵盤發文會漏存
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      if (!e.target.closest(EDITOR_SELECTOR)) return;

      console.log(LOG, 'Twitter: 偵測到鍵盤發文 (Cmd/Ctrl+Enter)');
      pipeline.capturePost();
    }, true);

    console.log(LOG, 'Twitter: 監聽已啟動');
  }

  pipeline.init(setupListener);
})();
