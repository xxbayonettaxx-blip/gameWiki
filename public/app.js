'use strict';

/**
 * =====================================================================
 * public/app.js
 * 役割：本番フロントエンド（読む体験優先・スライドドロワー＆上スライド設定版）
 * 主なUX・保守・セキュリティ方針：
 *   1. innerHTML は不使用（createElement + textContent でHTML解釈によるXSSを防止）。
 *   2. 普段は入力欄を隠し、「新規投稿」「返信」押下時のみスライド展開。
 *      （モバイル＝下からボトムシート、PC＝右からサイドドロワー）
 *   3. F1対策：選択要求中のスレッドID（loadingThreadId）と表示確定済みID（activeThreadId）を分離。
 *      GET取得中や取得失敗時は誤送信を防止し、表示中のスレッドと投稿先が食い違わないようにする。
 *   4. F4対策：閉じたドロワー・設定シートに inert を付与し、開いた時は即座にフォーカスを移動、
 *      Tabキー循環・Esc解除・閉じた後の元のボタンへのフォーカス復帰・再描画後のフォーカス維持を行う。
 * ===================================================================== */

(() => {
  const PREF_KEY = 'community-board-prefs-v1';
  const ALLOWED_THEMES = ['light', 'dark', 'paper', 'ud-light', 'ud-dark'];
  const ALLOWED_FONTS = [14, 16, 18];
  const AVATAR_COLORS = ['', 'sage', 'sand', 'blue'];
  const MAX_VISUAL_DEPTH = 2; // 親(0)・子(1)・孫(2)の3層までインデント、4層目以降はフラット

  const $ = (sel) => document.querySelector(sel);

  const state = {
    categories: [],
    activeCategory: null,       // 表示確定中のカテゴリ
    activeThreadId: null,       // GET成功により表示確定中のスレッドID
    activeThreadData: null,     // 表示確定中のスレッド詳細
    loadingThreadId: null,      // 現在GET通信中のスレッドID
    failedTargetThread: null,   // 直近の切替GETが失敗した対象 { id, title, categoryId } | null
    posts: [],
    replyTarget: null,          // { id, name, content } | null
    composerOpen: false,
    composerTriggerEl: null,
    composerTriggerSelector: null,
    settingsOpen: false,
    isSubmitting: false,
    loadSeq: 0,
    abortCtrl: null,
    toastTimer: null,
    prefs: {
      theme: 'light',
      font: 16,
      background: true,
    },
  };

  const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : jstFormatter.format(d);
  }

  function scrollBehavior() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  }

  function findThreadMeta(threadId) {
    for (const cat of state.categories) {
      const found = (cat.threads || []).find((t) => t.id === threadId);
      if (found) {
        return { category: cat, thread: found };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------
  // 1. 安全なDOM生成ヘルパー（textContent のみ使用）
  // -------------------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function pickCategoryIcon(catName) {
    if (catName.includes('質問')) return 'question';
    if (catName.includes('攻略') || catName.includes('検証')) return 'book';
    return 'chat';
  }

  function pickAvatarColor(visitorId) {
    if (!visitorId) return '';
    let sum = 0;
    for (let i = 0; i < visitorId.length; i += 1) {
      sum += visitorId.charCodeAt(i);
    }
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
  }

  function notify(message) {
    clearTimeout(state.toastTimer);
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3400);
  }

  function showErrorBanner(msg) {
    const banner = $('#error-banner');
    if (!msg) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    banner.textContent = `⚠ ${msg}`;
  }

  // -------------------------------------------------------------------
  // 2. 表示設定の読み込み・適用・保存（CSP準拠: data-* 属性使用）
  // -------------------------------------------------------------------
  function loadPreferences() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (ALLOWED_THEMES.includes(saved.theme)) state.prefs.theme = saved.theme;
        if (ALLOWED_FONTS.includes(saved.font)) state.prefs.font = saved.font;
        if (typeof saved.background === 'boolean') state.prefs.background = saved.background;
      }
    } catch {
      // 保存制限環境では既定値で継続
    }
    applyPreferences(false);
  }

  function applyPreferences(save = false) {
    document.documentElement.dataset.theme = state.prefs.theme;
    document.documentElement.dataset.font = String(state.prefs.font);
    document.body.classList.toggle('no-comment-bg', !state.prefs.background);

    document.querySelectorAll('button[data-set-theme]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.setTheme === state.prefs.theme));
    });
    document.querySelectorAll('button[data-set-font]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.setFont) === state.prefs.font));
    });
    $('#comment-background').checked = state.prefs.background;

    if (save) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));
      } catch {
        notify('表示を変更しました（このブラウザ設定では保存できません）。');
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. 上からスライド展開する「表示設定シート」の開閉（F4: inert・即時focus対応）
  // -------------------------------------------------------------------
  function openSettings() {
    if (state.composerOpen && window.innerWidth < 760) {
      closeComposer({ restoreFocus: false });
    }
    state.settingsOpen = true;
    const sheet = $('#settings-sheet');
    const backdrop = $('#settings-backdrop');
    const trigger = $('#settings-open');

    backdrop.hidden = false;
    sheet.inert = false;
    sheet.setAttribute('aria-hidden', 'false');
    sheet.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    // visibility: visible を即座にレイアウト確定させてからフォーカスを当てる
    void sheet.offsetWidth;
    $('#settings-close').focus({ preventScroll: true });
  }

  function closeSettings({ restoreFocus = true } = {}) {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    const sheet = $('#settings-sheet');
    const backdrop = $('#settings-backdrop');
    const trigger = $('#settings-open');

    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.inert = true;
    backdrop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function toggleSettings() {
    if (state.settingsOpen) closeSettings();
    else openSettings();
  }

  // -------------------------------------------------------------------
  // 4. スライド式投稿ドロワーの開閉 ＆ 送信可否・返信ハイライト制御
  // -------------------------------------------------------------------
  function canSubmitPost() {
    return (
      state.activeThreadId !== null &&
      state.loadingThreadId === null &&
      state.failedTargetThread === null &&
      !state.isSubmitting
    );
  }

  function syncSubmitAvailability() {
    const submitBtn = $('#submit-button');
    if (submitBtn) {
      submitBtn.disabled = !canSubmitPost();
    }
  }

  function syncReplyingTargetHighlight() {
    document.querySelectorAll('.is-replying-target').forEach((node) => {
      node.classList.remove('is-replying-target');
    });
    if (state.composerOpen && state.replyTarget) {
      const targetEl = document.getElementById(`post-${state.replyTarget.id}`);
      if (targetEl) {
        targetEl.classList.add('is-replying-target');
      }
    }
  }

  function syncComposerHeader() {
    const badge = $('#composer-mode-badge');
    const sub = $('#composer-thread-target');
    const previewBox = $('#reply-preview-box');
    const threadTitle = state.activeThreadData ? state.activeThreadData.title : '';

    if (state.loadingThreadId !== null) {
      const loadingMeta = findThreadMeta(state.loadingThreadId);
      const loadingTitle = loadingMeta ? loadingMeta.thread.title : `ID:${state.loadingThreadId}`;
      sub.textContent = `対象スレッド：${loadingTitle} を読み込み中...（完了まで送信待機）`;
    } else if (state.failedTargetThread !== null) {
      sub.textContent = `⚠ 「${state.failedTargetThread.title}」の取得失敗により送信停止中（表示中：${threadTitle || '-'}）`;
    } else {
      sub.textContent = threadTitle ? `対象スレッド：${threadTitle}` : '';
    }

    if (state.replyTarget) {
      badge.textContent = `↩ 返信モード（#${state.replyTarget.id}）`;
      badge.className = 'mode-badge is-reply';
      previewBox.hidden = false;
      $('#reply-label').textContent = `#${state.replyTarget.id} ${state.replyTarget.name} さんへの返信`;
      $('#reply-quote').textContent = state.replyTarget.content;
    } else {
      badge.textContent = '✎ 新規投稿';
      badge.className = 'mode-badge is-new';
      previewBox.hidden = true;
      $('#reply-label').textContent = '';
      $('#reply-quote').textContent = '';
    }

    syncReplyingTargetHighlight();
    syncSubmitAvailability();
  }

  function rememberTrigger(triggerEl) {
    if (!triggerEl) return;
    state.composerTriggerEl = triggerEl;
    if (triggerEl.id) {
      state.composerTriggerSelector = `#${triggerEl.id}`;
    } else if (triggerEl.dataset?.replyId) {
      state.composerTriggerSelector = `button[data-reply-id="${triggerEl.dataset.replyId}"]`;
    } else {
      state.composerTriggerSelector = null;
    }
  }

  function openComposer(replyPost = null, triggerEl = null) {
    if (state.settingsOpen) {
      closeSettings({ restoreFocus: false });
    }

    rememberTrigger(triggerEl);
    state.replyTarget = replyPost
      ? { id: replyPost.id, name: replyPost.author_name, content: replyPost.content }
      : null;
    state.composerOpen = true;

    if (state.failedTargetThread) {
      $('#form-error').textContent =
        `「${state.failedTargetThread.title}」の取得に失敗しているため書き込めません。「↻ 更新」で再取得するか、スレッドを選び直してください。`;
    } else {
      $('#form-error').textContent = '';
    }
    syncComposerHeader();

    const drawer = $('#composer-drawer');
    const backdrop = $('#composer-backdrop');
    backdrop.hidden = false;
    drawer.inert = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('is-open');
    document.body.classList.add('composer-open');

    if (replyPost) {
      const postEl = document.getElementById(`post-${replyPost.id}`);
      if (postEl) {
        postEl.scrollIntoView({
          behavior: scrollBehavior(),
          block: window.innerWidth < 760 ? 'end' : 'center',
        });
      }
    }

    // visibility: visible を即座に確定させてから本文欄へ確実にフォーカスを移す
    void drawer.offsetWidth;
    $('#comment-body').focus({ preventScroll: true });
  }

  function closeComposer({ restoreFocus = true, clearReply = false } = {}) {
    if (!state.composerOpen) {
      if (clearReply) state.replyTarget = null;
      syncReplyingTargetHighlight();
      return;
    }
    state.composerOpen = false;
    if (clearReply) state.replyTarget = null;

    const drawer = $('#composer-drawer');
    const backdrop = $('#composer-backdrop');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
    backdrop.hidden = true;
    document.body.classList.remove('composer-open');
    syncReplyingTargetHighlight();

    if (restoreFocus) {
      const target =
        (state.composerTriggerEl && document.contains(state.composerTriggerEl)
          ? state.composerTriggerEl
          : null) ||
        (state.composerTriggerSelector ? $(state.composerTriggerSelector) : null) ||
        $('#write-comment');
      target?.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------------------
  // 5. カテゴリ欄とスレッド選択カードの描画（F4: 再描画前後のフォーカス位置維持）
  // -------------------------------------------------------------------
  function renderNavigation() {
    const activeEl = document.activeElement;
    const focusedCatId = activeEl?.closest?.('#categories button[data-cat-id]')?.dataset?.catId ?? null;
    const focusedThreadId = activeEl?.closest?.('#threads button[data-thread-id]')?.dataset?.threadId ?? null;

    const catNav = $('#categories');
    catNav.replaceChildren(
      ...state.categories.map((cat) => {
        const isCurrent = state.activeCategory && cat.id === state.activeCategory.id;
        const btn = el('button', 'category-button');
        btn.type = 'button';
        btn.dataset.catId = String(cat.id);
        btn.setAttribute('aria-current', String(Boolean(isCurrent)));

        const countText = String(cat.threads?.length || 0).padStart(2, '0');
        btn.append(
          icon(pickCategoryIcon(cat.name)),
          el('span', '', cat.name),
          el('span', 'category-right', countText)
        );
        return btn;
      })
    );

    const threadsWrap = $('#threads');
    const threads = state.activeCategory?.threads || [];
    $('#thread-total').textContent = `${threads.length} THREADS`;

    threadsWrap.replaceChildren(
      ...threads.map((thread) => {
        // F1対策：選択済みマーク（✓・aria-pressed）は「表示が確定している activeThreadId」のみに付与する
        const selected = thread.id === state.activeThreadId;
        const btn = el('button', 'thread-card');
        btn.type = 'button';
        btn.dataset.threadId = String(thread.id);
        btn.setAttribute('aria-pressed', String(selected));
        if (state.loadingThreadId === thread.id) {
          btn.setAttribute('aria-busy', 'true');
        }
        btn.append(el('strong', '', thread.title));

        if (selected) {
          const check = el('span', 'check', '✓');
          check.setAttribute('aria-hidden', 'true');
          btn.append(check);
        }

        const meta = el('small');
        meta.append(icon('chat'), el('span', '', `${thread.post_count ?? 0} 件の投稿`));
        btn.append(meta);
        return btn;
      })
    );

    // DOMの作り直しで BODY に落ちたフォーカスを元のカテゴリ/スレッドボタンへ復元
    if (focusedCatId !== null) {
      catNav.querySelector(`button[data-cat-id="${focusedCatId}"]`)?.focus({ preventScroll: true });
    } else if (focusedThreadId !== null) {
      threadsWrap.querySelector(`button[data-thread-id="${focusedThreadId}"]`)?.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------------------
  // 6. ツリー構築 ➔「ピン留め投稿ツリー」と「通常投稿ツリー」へ分離描画
  // -------------------------------------------------------------------
  function buildTrees(flatPosts) {
    const map = new Map();
    for (const p of flatPosts) {
      map.set(p.id, { ...p, replies: [] });
    }
    const roots = [];
    for (const node of map.values()) {
      if (node.parent_id !== null && node.parent_id !== node.id && map.has(node.parent_id)) {
        map.get(node.parent_id).replies.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  function containsPinnedPost(node) {
    if (node.is_deleted !== 1 && node.is_pinned === 1) return true;
    return node.replies.some((child) => containsPinnedPost(child));
  }

  function renderPostNode(node, parentId, depth, renderedIds) {
    if (renderedIds.has(node.id)) return null;
    renderedIds.add(node.id);

    const isDeleted = node.is_deleted === 1;
    const article = el('article', parentId ? 'reply-entry' : 'comment-root');
    article.id = `post-${node.id}`;
    article.setAttribute('aria-label', `投稿 ${node.id}`);

    const row = el('div', 'comment');
    const initialChar = isDeleted ? '−' : [...(node.author_name || '名')][0] || '名';
    const avatarClass = isDeleted ? 'muted' : pickAvatarColor(node.visitor_id);
    const avatar = el('div', `avatar ${avatarClass}`.trim(), initialChar);
    avatar.setAttribute('aria-hidden', 'true');

    const main = el('div', 'comment-main');
    const meta = el('div', 'comment-meta');

    // コメント番号は名前のすぐ左隣に配置
    const postNumEl = el('span', 'post-number', `#${node.id}`);

    if (isDeleted) {
      meta.append(postNumEl, el('span', 'deleted-label', '削除された投稿'));
    } else {
      if (node.is_pinned === 1) {
        meta.append(el('span', 'pinned-badge', '📌 ピン留め'));
      }
      meta.append(
        postNumEl,
        el('span', 'comment-author', node.author_name),
        el('span', 'comment-id', `ID: ${node.visitor_id}`)
      );
    }

    const timeEl = el('time', 'comment-time', formatTime(node.created_at));
    if (node.created_at) timeEl.dateTime = node.created_at;
    meta.append(timeEl);
    main.append(meta);

    // >> はコメント欄（本文）先頭にインライン配置
    const textEl = el(
      'p',
      isDeleted ? 'deleted-text' : 'comment-text'
    );
    if (parentId) {
      const jumpBtn = el('button', 'reply-target', `>>${parentId}`);
      jumpBtn.type = 'button';
      jumpBtn.dataset.jumpId = String(parentId);
      jumpBtn.setAttribute('aria-label', `返信先 投稿 #${parentId} へ移動`);
      textEl.append(jumpBtn);
      textEl.append(document.createTextNode(' '));
    }
    textEl.append(
      document.createTextNode(
        isDeleted ? 'この投稿は削除されました。返信は引き続き表示されます。' : node.content
      )
    );
    main.append(textEl);
    if (!isDeleted) {
      const actions = el('div', 'comment-actions');
      const replyBtn = el('button', 'reply-button');
      replyBtn.type = 'button';
      replyBtn.dataset.replyId = String(node.id);
      replyBtn.setAttribute('aria-label', `投稿 ${node.id} に返信`);
      replyBtn.append(icon('reply'), document.createTextNode('返信'));
      actions.append(replyBtn);
      main.append(actions);
    }

    row.append(avatar, main);
    article.append(row);

    if (node.replies.length > 0) {
      const repliesContainer = el('div', depth < MAX_VISUAL_DEPTH ? 'replies' : 'replies-flat');
      for (const child of node.replies) {
        const childEl = renderPostNode(child, node.id, depth + 1, renderedIds);
        if (childEl) repliesContainer.append(childEl);
      }
      article.append(repliesContainer);
    }

    return article;
  }

  function renderAllPosts() {
    const roots = buildTrees(state.posts);
    const pinnedRoots = [];
    const normalRoots = [];

    for (const r of roots) {
      if (containsPinnedPost(r)) {
        pinnedRoots.push(r);
      } else {
        normalRoots.push(r);
      }
    }

    if ($('#sort').value === 'new') {
      normalRoots.reverse();
    }

    const renderedIds = new Set();

    const pinnedSection = $('#pinned-section');
    const pinnedContainer = $('#pinned-comments');
    if (pinnedRoots.length > 0) {
      pinnedSection.hidden = false;
      pinnedContainer.replaceChildren(
        ...pinnedRoots.map((r) => renderPostNode(r, null, 0, renderedIds)).filter(Boolean)
      );
    } else {
      pinnedSection.hidden = true;
      pinnedContainer.replaceChildren();
    }

    $('#comment-count').textContent = String(state.posts.length);
    const commentsContainer = $('#comments');
    if (normalRoots.length > 0) {
      commentsContainer.replaceChildren(
        ...normalRoots.map((r) => renderPostNode(r, null, 0, renderedIds)).filter(Boolean)
      );
    } else if (pinnedRoots.length > 0) {
      commentsContainer.replaceChildren(
        el('p', 'empty-message', 'その他の通常投稿はまだありません。「新規投稿」から書き込めます。')
      );
    } else {
      commentsContainer.replaceChildren(
        el('p', 'empty-message', 'まだ投稿はありません。「新規投稿」から最初のひと言を書いてみませんか？')
      );
    }

    syncReplyingTargetHighlight();
  }

  function syncHeaders() {
    if (!state.activeCategory) return;
    $('#breadcrumb-category').textContent = state.activeCategory.name;
    $('#category-title').textContent = state.activeCategory.name;
    $('#thread-category-tag').textContent = state.activeCategory.name;

    const threads = state.activeCategory.threads || [];
    const idx = threads.findIndex((t) => t.id === state.activeThreadId);
    $('#thread-label').textContent = `THREAD ${String(idx >= 0 ? idx + 1 : 1).padStart(2, '0')}`;

    if (state.activeThreadData) {
      $('#thread-title').textContent = state.activeThreadData.title;
    }
    syncComposerHeader();
  }

  // -------------------------------------------------------------------
  // 7. API通信：カテゴリ取得 ＆ スレッド詳細取得（F1: 確定IDと要求中IDの分離）
  // -------------------------------------------------------------------
  async function loadInitialData() {
    showErrorBanner('');
    try {
      const res = await fetch('api/categories', { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      state.categories = Array.isArray(data.categories) ? data.categories : [];
      if (state.categories.length === 0) {
        $('#category-title').textContent = 'カテゴリがありません';
        syncSubmitAvailability();
        return;
      }

      state.activeCategory = state.categories[0];
      const firstThread = state.activeCategory.threads?.[0];
      renderNavigation();
      syncHeaders();

      if (firstThread) {
        await loadThread(firstThread.id);
      } else {
        syncSubmitAvailability();
      }
    } catch (err) {
      showErrorBanner(err.message || 'サーバーとの通信に失敗しました。');
      syncSubmitAvailability();
    }
  }

  function shouldKeepTriggerFocus(preserveFocusSelector) {
    if (!preserveFocusSelector) return false;
    if (state.settingsOpen || state.composerOpen || $('#guide-dialog')?.open) {
      return false;
    }
    const triggerEl = $(preserveFocusSelector);
    if (!triggerEl) return false;
    const activeEl = document.activeElement;
    return activeEl === triggerEl || triggerEl.contains(activeEl);
  }

  async function loadThread(threadId, { preserveFocusSelector = null } = {}) {
    if (state.abortCtrl) state.abortCtrl.abort();
    const ctrl = new AbortController();
    state.abortCtrl = ctrl;
    const seq = ++state.loadSeq;

    const targetMeta = findThreadMeta(threadId);
    const previousThreadId = state.activeThreadId;

    state.loadingThreadId = threadId;
    state.failedTargetThread = null;
    showErrorBanner('');
    $('#form-error').textContent = '';
    renderNavigation();
    if (
      preserveFocusSelector &&
      !state.settingsOpen &&
      !state.composerOpen &&
      !$('#guide-dialog')?.open
    ) {
      const triggerEl = $(preserveFocusSelector);
      const activeEl = document.activeElement;
      if (
        triggerEl &&
        (activeEl === document.body ||
          activeEl === document.documentElement ||
          triggerEl.contains(activeEl))
      ) {
        triggerEl.focus({ preventScroll: true });
      }
    }
    syncComposerHeader();

    try {
      const res = await fetch(`api/threads/${encodeURIComponent(String(threadId))}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== state.loadSeq) return false;

      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // 応答待ちの間に利用者が設定パネルや別要素へフォーカスを移していないかを再描画前に判定
      const restoreTriggerFocus = shouldKeepTriggerFocus(preserveFocusSelector);

      // GET成功時点で初めて表示確定スレッド（activeCategory / activeThreadId / activeThreadData）を更新する
      const confirmedMeta = findThreadMeta(data.thread.id);
      if (confirmedMeta) {
        state.activeCategory = confirmedMeta.category;
      }
      const switchedThread = previousThreadId !== null && previousThreadId !== data.thread.id;
      state.activeThreadId = data.thread.id;
      state.activeThreadData = data.thread;
      state.loadingThreadId = null;
      state.failedTargetThread = null;
      state.posts = Array.isArray(data.posts) ? data.posts : [];

      if (switchedThread) {
        state.replyTarget = null;
        if (window.innerWidth < 760) {
          closeComposer({ restoreFocus: false, clearReply: true });
        }
      }

      if (state.activeCategory) {
        const tSummary = state.activeCategory.threads.find((t) => t.id === data.thread.id);
        if (tSummary) tSummary.post_count = state.posts.length;
      }

      renderNavigation();
      syncHeaders();
      renderAllPosts();

      if (restoreTriggerFocus) {
        $(preserveFocusSelector)?.focus({ preventScroll: true });
      }
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      if (seq !== state.loadSeq) return false;

      const restoreTriggerFocus = shouldKeepTriggerFocus(preserveFocusSelector);

      state.loadingThreadId = null;
      const failedTitle = targetMeta ? targetMeta.thread.title : `スレッド #${threadId}`;

      // F1対策：別スレッドへの切替取得が失敗した場合、誤ったスレッドへ投稿されるのを防ぐため送信を一時ロックする
      state.failedTargetThread = {
        id: threadId,
        title: failedTitle,
        categoryId: targetMeta ? targetMeta.category.id : null,
      };

      const currentTitle = state.activeThreadData ? state.activeThreadData.title : '未選択';
      showErrorBanner(
        `「${failedTitle}」の取得に失敗しました（${err.message || '通信エラー'}）。誤投稿防止のため、再取得または元のスレッド（${currentTitle}）を選び直すまで書き込みを停止しています。`
      );
      if (state.composerOpen) {
        $('#form-error').textContent =
          `「${failedTitle}」の取得に失敗したため送信を停止しています。「↻ 更新」を押すかスレッドを選び直してください。`;
      }

      renderNavigation();
      syncHeaders();
      if (restoreTriggerFocus) {
        $(preserveFocusSelector)?.focus({ preventScroll: true });
      }
      return false;
    }
  }

  // -------------------------------------------------------------------
  // 8. 投稿送信処理（F1: 送信開始時点の対象ID・本文・返信先をスナップショット固定）
  // -------------------------------------------------------------------
  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmitPost()) {
      if (state.loadingThreadId !== null) {
        $('#form-error').textContent = 'スレッドを読み込み中です。完了してから送信してください。';
      } else if (state.failedTargetThread !== null) {
        $('#form-error').textContent =
          `「${state.failedTargetThread.title}」の取得に失敗しているため送信できません。「↻ 更新」またはスレッド再選択を行ってください。`;
      }
      return;
    }

    const rawContent = $('#comment-body').value;
    if (rawContent.replace(/[\s\u3000\u200B-\u200D\u2060\uFEFF]+/g, '').length === 0) {
      $('#form-error').textContent = '空白や改行のみの本文は投稿できません。';
      $('#comment-body').focus();
      return;
    }

    // 送信開始時点のスレッドID・返信先ID・名前・本文をローカル定数に固定する
    const submitThreadId = state.activeThreadId;
    const submitReplyId = state.replyTarget ? state.replyTarget.id : null;
    const submitAuthor = $('#author-name').value;
    const submitContent = rawContent;

    state.isSubmitting = true;
    syncSubmitAvailability();
    $('#form-error').textContent = '';

    try {
      const res = await fetch('api/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          thread_id: submitThreadId,
          parent_id: submitReplyId,
          author_name: submitAuthor,
          content: submitContent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `投稿に失敗しました (HTTP ${res.status})`);
      }

      // 送信中にユーザーが本文を書き換えていない場合のみクリアする（下書き破壊防止）
      if ($('#comment-body').value === submitContent) {
        $('#comment-body').value = '';
        $('#character-count').textContent = '0 / 2,000';
      } else {
        const len = $('#comment-body').value.length;
        $('#character-count').textContent = `${len.toLocaleString('ja-JP')} / 2,000`;
      }

      // 送信対象スレッドをまだ表示中の場合のみドロワーを閉じて最新一覧を再取得する
      if (state.activeThreadId === submitThreadId && state.loadingThreadId === null) {
        const sameReplyTarget = (state.replyTarget?.id ?? null) === submitReplyId;
        if (sameReplyTarget && $('#comment-body').value === '') {
          closeComposer({ restoreFocus: false, clearReply: true });
        }
        await loadThread(submitThreadId);

        const newPostEl = document.getElementById(`post-${data.post.id}`);
        if (newPostEl) {
          newPostEl.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
          newPostEl.classList.add('highlight-post');
          setTimeout(() => newPostEl.classList.remove('highlight-post'), 1800);
        }
      }
      notify(`投稿 #${data.post.id} を書き込みました。`);
    } catch (err) {
      $('#form-error').textContent =
        err instanceof TypeError
          ? '通信に失敗しました。オフラインまたはサーバー停止中の可能性があります。'
          : err.message;
    } finally {
      state.isSubmitting = false;
      syncSubmitAvailability();
    }
  }

  // -------------------------------------------------------------------
  // 9. イベント登録（イベント委譲＋開いているパネル内のTabフォーカス循環）
  // -------------------------------------------------------------------
  function initEvents() {
    // カテゴリ切替（GET成功時にカテゴリ・スレッドを確定し、フォーカスも維持）
    $('#categories').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-cat-id]');
      if (!btn) return;
      const catId = Number(btn.dataset.catId);
      const found = state.categories.find((c) => c.id === catId);
      if (!found) return;

      const targetThreadId = found.threads?.[0]?.id ?? null;
      if (
        found.id === state.activeCategory?.id &&
        targetThreadId === state.activeThreadId &&
        state.loadingThreadId === null &&
        state.failedTargetThread === null
      ) {
        return;
      }

      const focusSel = `#categories button[data-cat-id="${catId}"]`;
      if (targetThreadId !== null) {
        await loadThread(targetThreadId, { preserveFocusSelector: focusSel });
      }
    });

    // スレッド切替（A→B→A の高速切替や失敗後の元スレッド再選択も正しく通す）
    $('#threads').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-thread-id]');
      if (!btn) return;
      const threadId = Number(btn.dataset.threadId);

      // すでにそのスレッドが確定表示中で、読込中でも失敗停止中でもない場合のみスキップ
      if (
        threadId === state.activeThreadId &&
        state.loadingThreadId === null &&
        state.failedTargetThread === null
      ) {
        return;
      }

      const focusSel = `#threads button[data-thread-id="${threadId}"]`;
      await loadThread(threadId, { preserveFocusSelector: focusSel });
    });

    // 投稿内の「返信」ボタン ＆ 「>>親番号ジャンプ」
    const handlePostInteraction = (e) => {
      const replyBtn = e.target.closest('button[data-reply-id]');
      if (replyBtn) {
        const id = Number(replyBtn.dataset.replyId);
        const post = state.posts.find((p) => p.id === id);
        if (post) openComposer(post, replyBtn);
        return;
      }

      const jumpBtn = e.target.closest('button[data-jump-id]');
      if (jumpBtn) {
        const targetEl = document.getElementById(`post-${jumpBtn.dataset.jumpId}`);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
          targetEl.classList.add('highlight-post');
          setTimeout(() => targetEl.classList.remove('highlight-post'), 1600);
        }
      }
    };
    $('#pinned-comments').addEventListener('click', handlePostInteraction);
    $('#comments').addEventListener('click', handlePostInteraction);

    // 新規投稿ドロワーを開く（ツールバー内ボタン ＆ 右下FAB）
    $('#write-comment').addEventListener('click', (e) => openComposer(null, e.currentTarget));
    $('#fab-write').addEventListener('click', (e) => openComposer(null, e.currentTarget));

    // ドロワー操作（閉じる・返信から新規投稿への切替）
    $('#composer-close').addEventListener('click', () => closeComposer());
    $('#composer-backdrop').addEventListener('click', () => closeComposer());
    $('#reply-switch-new').addEventListener('click', () => {
      state.replyTarget = null;
      syncComposerHeader();
      $('#comment-body').focus();
    });

    // 「↻ 更新」は直近で失敗したスレッドがあればその再取得、なければ現在表示中のスレッドを再取得
    $('#reload-thread').addEventListener('click', () => {
      const targetId = state.failedTargetThread ? state.failedTargetThread.id : state.activeThreadId;
      if (targetId !== null) {
        loadThread(targetId, { preserveFocusSelector: '#reload-thread' });
      }
    });
    $('#sort').addEventListener('change', renderAllPosts);

    $('#comment-body').addEventListener('input', () => {
      const len = $('#comment-body').value.length;
      $('#character-count').textContent = `${len.toLocaleString('ja-JP')} / 2,000`;
      if (!state.failedTargetThread) {
        $('#form-error').textContent = '';
      }
    });

    $('#comment-form').addEventListener('submit', handleSubmit);

    // 上スライド表示設定シートの開閉 ＆ 設定変更
    $('#settings-open').addEventListener('click', toggleSettings);
    $('#settings-close').addEventListener('click', () => closeSettings());
    $('#settings-backdrop').addEventListener('click', () => closeSettings());

    document.querySelectorAll('button[data-set-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.prefs.theme = btn.dataset.setTheme;
        applyPreferences(true);
      });
    });
    document.querySelectorAll('button[data-set-font]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.prefs.font = Number(btn.dataset.setFont);
        applyPreferences(true);
      });
    });
    $('#comment-background').addEventListener('change', (e) => {
      state.prefs.background = e.target.checked;
      applyPreferences(true);
    });

    // 使い方ダイアログ
    for (const sel of ['#guide-open', '#sidebar-guide', '#footer-guide']) {
      $(sel)?.addEventListener('click', () => $('#guide-dialog').showModal());
    }
    $('#guide-close').addEventListener('click', () => $('#guide-dialog').close());
    $('#guide-dialog').addEventListener('click', (e) => {
      const dialog = e.currentTarget;
      if (e.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (
        e.clientX < box.left ||
        e.clientX > box.right ||
        e.clientY < box.top ||
        e.clientY > box.bottom
      ) {
        dialog.close();
      }
    });

    // キーボード操作（Esc でパネルを閉じる ＆ 開いているパネル内で Tab / Shift+Tab を循環させる）
    document.addEventListener('keydown', (e) => {
      if ($('#guide-dialog').open) return;

      if (e.key === 'Escape') {
        if (state.settingsOpen) {
          e.preventDefault();
          closeSettings();
        } else if (state.composerOpen) {
          e.preventDefault();
          closeComposer();
        }
        return;
      }

      if (e.key === 'Tab') {
        const activePanel = state.settingsOpen
          ? $('#settings-sheet')
          : state.composerOpen
            ? $('#composer-drawer')
            : null;
        if (!activePanel) return;

        const focusables = [
          ...activePanel.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ),
        ].filter((node) => !node.closest('[hidden]'));

        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !activePanel.contains(document.activeElement)) {
            e.preventDefault();
            last.focus({ preventScroll: true });
          }
        } else if (document.activeElement === last || !activePanel.contains(document.activeElement)) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    });
  }

  loadPreferences();
  initEvents();
  loadInitialData();
})();
