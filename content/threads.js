// Threads 平台擷取器：DOM 擷取與按鈕偵測；發佈/草稿流程共用 SP2O.createPublishPipeline
(function () {
  'use strict';

  const LOG = '[Social Post to Obsidian]';
  const INPUT_SELECTOR = '[contenteditable="true"], [role="textbox"], textarea';
  const SUBMIT_SELECTOR = '[role="button"], button[type="submit"]';
  const COMPOSER_BOUNDARY_SELECTOR = 'main, [role="main"], nav, [role="navigation"]';

  // 檢查按鈕是否是最終的「發佈」或「回覆」按鈕。
  // Threads 沒有可靠的 data-testid 可用，只能精確比對文字；
  // 呼叫端會再確認它與輸入框同屬一個局部 composer，避免誤抓頁面上的其他按鈕
  function isPostButton(element) {
    if (!element) return false;

    // 取得按鈕的直接文字（去除空白）
    const text = element.textContent?.trim().toLowerCase() || '';
    const ariaLabel = element.getAttribute('aria-label')?.trim().toLowerCase() || '';

    // 只匹配精確的發佈或回覆按鈕
    // 避免匹配「新增到串文」、「回覆選項」等其他按鈕
    const exactPostKeywords = ['post', 'reply', '發佈', '發布', '回覆'];

    return exactPostKeywords.some(keyword =>
      text === keyword || ariaLabel === keyword
    );
  }

  // Threads 一般發文使用 dialog，但貼文頁回覆會使用沒有 role="dialog" 的 inline
  // composer。從事件來源往上找「同時包含輸入框與精確送出按鈕」的最小容器，
  // 並在 main/navigation 邊界前停止，避免退回整頁而把搜尋框當成草稿。
  function findComposer(source) {
    if (!source || typeof source.closest !== 'function') return null;

    const dialog = source.closest('[role="dialog"]');
    if (dialog) return dialog;

    const boundary = source.closest(COMPOSER_BOUNDARY_SELECTOR);
    let current = source.parentElement;
    while (current
      && current !== boundary
      && current !== document.body
      && current !== document.documentElement) {
      const inputs = current.querySelectorAll?.(INPUT_SELECTOR) || [];
      const buttons = current.querySelectorAll?.(SUBMIT_SELECTOR) || [];
      if (inputs.length && Array.from(buttons).some(isPostButton)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getComposer(source) {
    const composer = findComposer(source);
    if (composer) return composer;
    // 測試與舊呼叫端未提供 source 時，仍只允許明確的 dialog，不 fallback 到 document。
    return source ? null : document.querySelector('[role="dialog"]');
  }

  // 取得輸入框的文字內容（支援串文多則）
  function getTextContent(source) {
    const root = getComposer(source);
    if (!root) {
      console.log(LOG, 'Threads: 找不到 composer');
      return null;
    }
    const inputs = root.querySelectorAll(INPUT_SELECTOR);

    if (!inputs || inputs.length === 0) {
      console.log(LOG, 'Threads: 找不到輸入框');
      return null;
    }

    const texts = [];

    inputs.forEach((input) => {
      let text = '';
      if (input.innerText) {
        text = input.innerText.trim();
      } else if (input.textContent) {
        text = input.textContent.trim();
      } else if (input.value) {
        text = input.value.trim();
      }

      // 只加入有內容的
      if (text && text !== '' && text !== '\n') {
        texts.push(text);
      }
    });

    if (texts.length === 0) {
      console.log(LOG, 'Threads: 所有輸入框都是空的');
      return null;
    }

    console.log(LOG, `Threads: 擷取到 ${texts.length} 則內容`);
    return texts;
  }

  // 擷取引用貼文資訊（DOM 備援；正式資料以攔截到的發文 API 回應為準）
  function getQuotedPost(source) {
    const composer = getComposer(source);
    if (!composer) return null;

    // Threads 引用貼文容器有 data-pressable-container="true" 屬性
    const quoteContainer = composer.querySelector('[data-pressable-container="true"]');
    if (!quoteContainer) return null;

    // 擷取原作者（從 href="/@username" 連結）
    const authorLink = quoteContainer.querySelector('a[href^="/@"]');
    const authorHandle = authorLink?.getAttribute('href')?.replace('/@', '');

    // 擷取作者顯示名稱
    const authorNameEl = quoteContainer.querySelector('a[href^="/@"] span span');
    const authorName = authorNameEl?.textContent?.trim();

    // 擷取貼文連結
    const postLink = quoteContainer.querySelector('a[href*="/post/"]');
    const url = postLink ? `https://www.threads.com${postLink.getAttribute('href')}` : '';

    // 擷取貼文內容（在 x1gslohp class 的 div 裡）
    const contentContainer = quoteContainer.querySelector('.x1gslohp');
    let content = '';
    if (contentContainer) {
      // 取得所有 span[dir="auto"] 的文字
      const textSpans = contentContainer.querySelectorAll('span[dir="auto"] > span');
      const texts = [];
      textSpans.forEach(span => {
        const text = span.textContent?.trim();
        if (text) texts.push(text);
      });
      content = texts.join('\n');
    }

    if (!content && !authorHandle) return null;

    console.log(LOG, 'Threads: 偵測到引用貼文 (DOM)', authorHandle);

    return {
      author: authorHandle || 'unknown',
      authorName: authorName || authorHandle || 'unknown',
      content: content || '',
      url: url || ''
    };
  }

  // Threads 的 create response 不會穩定提供被回覆貼文，只能靠 DOM。
  //
  // 貼文頁的 inline composer 有明確頁面 URL，可直接當 replyTo；dialog 可能是一般
  // 發文，不能用頁面網址猜，只認 dialog 內顯示的母貼文連結。抓不到一律回 null。
  function getReplyTo(source) {
    const composer = getComposer(source);
    if (!composer) return null;

    if (source?.closest?.('[role="dialog"]')) {
      const href = composer.querySelector('a[href*="/post/"]')?.getAttribute('href') || '';
      const path = href.match(/\/@?([^/?#]+)\/post\/([^/?#]+)/);
      return path ? `https://www.threads.com/@${path[1]}/post/${path[2]}` : null;
    }

    const match = String(window.location.href || '').match(
      /^(https:\/\/(?:www\.)?threads\.(?:com|net)\/@[^/?#]+\/post\/[^/?#]+)/i
    );
    if (!match) return null;
    return match[1].replace(
      /^https:\/\/(?:www\.)?threads\.(?:com|net)/i,
      'https://www.threads.com'
    );
  }

  const pipeline = SP2O.createPublishPipeline({
    platform: 'threads',
    label: 'Threads',
    parseResponse: SP2O.parseThreadsCreate,
    getTextContent: getTextContent,
    getQuoted: getQuotedPost,
    getReplyTo: getReplyTo,
    // 只監聽已確認屬於 dialog 或 inline composer 的輸入框；不接受整頁 fallback。
    getDraftInputs: (source) => {
      if (source) {
        const composer = getComposer(source);
        return composer ? Array.from(composer.querySelectorAll(INPUT_SELECTOR)) : [];
      }
      return Array.from(document.querySelectorAll(INPUT_SELECTOR)).filter(findComposer);
    }
  });

  // 設定事件監聽
  function setupListener() {
    // 使用事件委派，在 capture phase 捕捉點擊
    document.addEventListener('click', (e) => {
      const button = e.target.closest(SUBMIT_SELECTOR);
      if (!button) return;

      if (!isPostButton(button)) return;
      if (!findComposer(button)) return;

      console.log(
        LOG,
        'Threads: 偵測到送出按鈕',
        button.textContent?.trim().toLowerCase()
          || button.getAttribute('aria-label')?.trim().toLowerCase()
          || ''
      );
      pipeline.capturePost(button);
    }, true);

    // 鍵盤發文（Cmd/Ctrl+Enter）：舊版只偵測點擊，鍵盤發文會漏存
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      if (!findComposer(e.target)) return;

      console.log(LOG, 'Threads: 偵測到鍵盤發文 (Cmd/Ctrl+Enter)');
      pipeline.capturePost(e.target);
    }, true);

    console.log(LOG, 'Threads: 監聽已啟動');
  }

  pipeline.init(setupListener);
})();
