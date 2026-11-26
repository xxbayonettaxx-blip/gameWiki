'use strict';

/**
 * =====================================================================
 * public/admin.js
 * 役割：管理画面 (admin.html) の全UI構築・実API連携・キーボードA11y制御
 * 方針：
 *   - DOM構築は createElement / createElementNS / textContent のみ使用（XSS遮断）。
 *   - 相対パス ('./') で API・戻りリンクを呼び出し、'/' と '/board/' 両配備に両立する。
 *   - 401/403時はワークスペースを隠して認証ゲートのみ表示する。
 *   - スレッド別投稿取得は AbortController ＋ 要求連番 ＋ 選択ID照合で逆転上書きを防ぐ。
 *   - 破壊的操作（カテゴリ削除・スレッド物理削除）は専用確認ダイアログ＋サーバー側ガードで保護する。
 * =====================================================================
 */

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PREF_KEY = 'community-board-prefs-v1';
  const ALLOWED_THEMES = ['light', 'dark', 'paper', 'ud-light', 'ud-dark'];
  const THEME_LABELS = [
    ['light', 'ライト'],
    ['dark', 'ダーク'],
    ['paper', 'ペーパー'],
    ['ud-light', 'UDライト'],
    ['ud-dark', 'UDダーク'],
  ];
  const ALLOWED_FONTS = [14, 16, 18];
  const FONT_LABELS = [
    [14, '小 (14px)'],
    [16, '中 (16px)'],
    [18, '大 (18px)'],
  ];
  const CATEGORY_THEMES = ['violet', 'blue', 'mint', 'sand'];
  const USERS_PAGE_LIMIT = 50;
  const AUDIT_PAGE_LIMIT = 50;

  const SECTIONS = [
    ['overview', 'home', '概要'],
    ['structure', 'folder', 'カテゴリ'],
    ['posts', 'message', '投稿管理'],
    ['members', 'users', '会員'],
    ['audit', 'log', '監査ログ'],
  ];

  const AUDIT_ACTION_META = {
    category_create: { label: 'カテゴリを追加', icon: 'plus', theme: 'mint' },
    category_update: { label: 'カテゴリを更新', icon: 'edit', theme: 'violet' },
    category_delete: { label: 'カテゴリを削除', icon: 'trash', theme: 'sand' },
    thread_create: { label: 'スレッドを作成', icon: 'plus', theme: 'mint' },
    thread_update: { label: 'スレッドを更新', icon: 'edit', theme: 'violet' },
    thread_purge: { label: 'スレッドを物理削除', icon: 'trash', theme: 'sand' },
    post_soft_delete: { label: '投稿を非表示に変更', icon: 'eye', theme: 'sand' },
    post_pin: { label: '投稿をピン留め', icon: 'pin', theme: 'blue' },
    post_unpin: { label: '投稿のピン留めを解除', icon: 'pin', theme: 'violet' },
    post_update: { label: '投稿を編集', icon: 'edit', theme: 'violet' },
    post_purge_tree: { label: '投稿ツリーを物理削除', icon: 'trash', theme: 'sand' },
    user_create: { label: 'ユーザーを作成', icon: 'users', theme: 'mint' },
    user_reset_password: { label: '仮パスワードを設定', icon: 'settings', theme: 'sand' },
    user_role_change: { label: '会員ロールを変更', icon: 'users', theme: 'blue' },
    user_revoke_sessions: { label: 'セッションを強制失効', icon: 'settings', theme: 'sand' },
  };

  const $ = (sel) => document.querySelector(sel);

  const state = {
    user: null,
    summary: null,
    categories: [],
    recentAuditLogs: [],
    page: 'overview',
    openCategories: new Set(),
    searchClosed: new Set(),
    initializedAccordions: false,
    query: '',
    selectedModThreadId: null,
    postFilter: 'all',
    modPosts: [],
    modPostsSeq: 0,
    modPostsLoading: false,
    modPostsError: '',
    modAbortCtrl: null,
    users: [],
    usersTotal: 0,
    usersOffset: 0,
    auditLogs: [],
    auditHasMore: false,
    auditNextBeforeId: null,
    dialog: null,
    editorDialogSeq: 0,
    triggerEl: null,
    purgeContext: null,
    purgePreviewSeq: 0,
    purgePreviewAbortCtrl: null,
    purgeDialogSeq: 0,
    deleteCatContext: null,
    deleteCatDialogSeq: 0,
    pendingPinPostIds: new Set(),
    toastTimer: null,
  };

  // -------------------------------------------------------------------
  // 1. 表示設定（一般画面と localStorage キーを共有し他キーを保持する）
  // -------------------------------------------------------------------
  function readStoredPreferences() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function applyStoredPreferences() {
    const saved = readStoredPreferences();
    const theme = ALLOWED_THEMES.includes(saved.theme) ? saved.theme : 'light';
    const font = ALLOWED_FONTS.includes(Number(saved.font)) ? Number(saved.font) : 16;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.font = String(font);

    const isDark = theme === 'dark' || theme === 'ud-dark';
    const themeBtn = $('#admin-theme-toggle');
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(isDark));
      const useNode = themeBtn.querySelector('use');
      if (useNode) {
        useNode.setAttribute('href', isDark ? '#icon-sun' : '#icon-moon');
      }
    }
  }

  function savePreferences({ theme, font }) {
    const prev = readStoredPreferences();
    const nextTheme = ALLOWED_THEMES.includes(theme)
      ? theme
      : ALLOWED_THEMES.includes(prev.theme)
        ? prev.theme
        : 'light';
    const nextFont = ALLOWED_FONTS.includes(Number(font))
      ? Number(font)
      : ALLOWED_FONTS.includes(Number(prev.font))
        ? Number(prev.font)
        : 16;

    const merged = {
      ...prev,
      theme: nextTheme,
      font: nextFont,
    };
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(merged));
    } catch {
      // localStorage が制限された環境では画面反映のみ行う
    }
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.dataset.font = String(nextFont);
    const isDark = nextTheme === 'dark' || nextTheme === 'ud-dark';
    const themeBtn = $('#admin-theme-toggle');
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', String(isDark));
      const useNode = themeBtn.querySelector('use');
      if (useNode) {
        useNode.setAttribute('href', isDark ? '#icon-sun' : '#icon-moon');
      }
    }
  }

  // -------------------------------------------------------------------
  // 2. DOM生成・時刻整形・エラー・トーストヘルパー
  // -------------------------------------------------------------------
  const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : jstFormatter.format(d);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name, className = '') {
    const wrap = el('span', `icon ${className}`.trim());
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    wrap.append(svg);
    return wrap;
  }

  function makeBtn(label, action, glyph, kind = 'secondary', attrs = {}) {
    const btn = el('button', `btn ${kind}`);
    btn.type = 'button';
    if (action) btn.dataset.action = action;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'disabled') {
        btn.disabled = Boolean(v);
      } else if (k === 'id') {
        btn.id = String(v);
      } else if (k.startsWith('data-')) {
        btn.setAttribute(k, String(v));
      } else {
        btn.setAttribute(k, String(v));
      }
    }
    if (glyph) btn.append(icon(glyph));
    btn.append(document.createTextNode(label));
    return btn;
  }

  function notify(message) {
    window.clearTimeout(state.toastTimer);
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    if (message) {
      state.toastTimer = window.setTimeout(() => {
        toast.textContent = '';
      }, 3400);
    }
  }

  function showErrorBanner(message, focusBanner = false) {
    const banner = $('#admin-error-banner');
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    banner.textContent = `⚠ ${message}`;
    if (focusBanner) {
      banner.focus();
    }
  }

  function showAuthGate(message) {
    closeEditorDialog({ restoreFocus: false });
    closePurgeThreadDialog({ restoreFocus: false });
    closeDeleteCategoryDialog({ restoreFocus: false });
    $('#admin-workspace').hidden = true;
    $('#admin-operator-badge').hidden = true;
    $('#admin-auth-gate').hidden = false;
    $('#admin-gate-message').textContent = message;
  }

  function showWorkspace() {
    $('#admin-auth-gate').hidden = true;
    $('#admin-workspace').hidden = false;
    if (state.user) {
      const badge = $('#admin-operator-badge');
      const avatar = $('#admin-operator-avatar');
      const nameEl = $('#admin-operator-name');
      const initialChar = [...(state.user.username || '管')][0] || '管';
      if (avatar) avatar.textContent = initialChar;
      if (nameEl) nameEl.textContent = state.user.username;
      if (badge) badge.hidden = false;
    }
  }

  function categoryThemeAt(index) {
    return CATEGORY_THEMES[index % CATEGORY_THEMES.length];
  }

  function allThreadsFlat() {
    const list = [];
    for (const cat of state.categories) {
      for (const th of cat.threads || []) {
        list.push({ categoryName: cat.name, ...th });
      }
    }
    return list;
  }

  function findCategoryById(categoryId) {
    return state.categories.find((c) => c.id === Number(categoryId)) || null;
  }

  function findThreadById(threadId) {
    for (const cat of state.categories) {
      const found = (cat.threads || []).find((th) => th.id === Number(threadId));
      if (found) return { category: cat, thread: found };
    }
    return null;
  }

  function ensureValidSelectedModThread() {
    const flat = allThreadsFlat();
    if (flat.length === 0) {
      state.selectedModThreadId = null;
      return;
    }
    if (!state.selectedModThreadId || !flat.some((t) => t.id === Number(state.selectedModThreadId))) {
      state.selectedModThreadId = flat[0].id;
    }
  }

  function buildFocusSelector(node) {
    if (!node || !node.dataset) return null;
    if (node.id) return `#${node.id}`;
    const action = node.dataset.action;
    if (action && node.dataset.threadId) {
      return `[data-action="${action}"][data-thread-id="${node.dataset.threadId}"]`;
    }
    if (action && node.dataset.categoryId) {
      return `[data-action="${action}"][data-category-id="${node.dataset.categoryId}"]`;
    }
    if (action && node.dataset.postId) {
      return `[data-action="${action}"][data-post-id="${node.dataset.postId}"]`;
    }
    if (action) return `[data-action="${action}"]`;
    return null;
  }

  // -------------------------------------------------------------------
  // 3. 相対パス JSON API 呼び出し共通ラッパー
  // -------------------------------------------------------------------
  async function apiRequest(relativePath, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = {};
    let bodyText;
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      bodyText = JSON.stringify(options.body === undefined ? {} : options.body);
    }
    const res = await window.fetch(relativePath, {
      method,
      credentials: 'same-origin',
      headers,
      body: bodyText,
      signal: options.signal,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `HTTPエラー (${res.status})`);
      err.status = res.status;
      err.code = payload?.code || null;
      err.details = payload?.details || null;
      if (res.status === 401 || res.status === 403) {
        if (err.code === 'PASSWORD_CHANGE_REQUIRED') {
          showAuthGate('仮パスワードの変更が必要です。掲示板ページのアカウントメニューからパスワードを変更し、再ログインしてください。');
        } else if (err.code === 'FORBIDDEN') {
          showAuthGate('このアカウントには管理者権限がありません。管理者アカウントでログインしてください。');
        } else {
          showAuthGate(err.message || '管理者アカウントでのログインが必要です。');
        }
      }
      throw err;
    }
    return payload;
  }

  // -------------------------------------------------------------------
  // 4. ナビゲーション・ページ描画
  // -------------------------------------------------------------------
  function renderNavigation() {
    const nav = $('#navigation');
    if (!nav) return;
    nav.replaceChildren();

    for (const [key, glyph, label] of SECTIONS) {
      const selected = state.page === key;
      const btn = el('button', 'nav-btn');
      btn.type = 'button';
      btn.id = `nav-btn-${key}`;
      btn.dataset.page = key;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) {
        btn.setAttribute('aria-current', 'page');
      }
      btn.append(icon(glyph), document.createTextNode(label));
      nav.append(btn);
    }

    const activeMeta = SECTIONS.find(([key]) => key === state.page) || SECTIONS[0];
    const crumb = $('#crumb-current');
    if (crumb) crumb.textContent = activeMeta[2];
  }

  function buildPageHeading(headingText, descriptionText, actions = null) {
    const header = el('header', 'page-heading');
    const left = el('div');
    left.append(el('h1', '', headingText), el('p', '', descriptionText));
    header.append(left);
    const list = Array.isArray(actions) ? actions.filter(Boolean) : actions ? [actions] : [];
    if (list.length > 0) {
      const actionWrap = el('div', 'page-heading-actions');
      actionWrap.append(...list);
      header.append(actionWrap);
    }
    return header;
  }

  function buildStatsGrid() {
    const summary = state.summary || {
      categoriesCount: 0,
      threadsCount: 0,
      postsCount: 0,
      usersCount: 0,
      adminsCount: 0,
    };
    const grid = el('section', 'stats');
    grid.setAttribute('aria-label', '掲示板の件数');

    const cards = [
      ['stat-categories', summary.categoriesCount, 'カテゴリ', '掲示板全体', 'folder', 'violet'],
      ['stat-threads', summary.threadsCount, 'スレッド', 'カテゴリに所属', 'layers', 'blue'],
      ['stat-posts', summary.postsCount, '総投稿数', '返信を含む', 'message', 'mint'],
      ['stat-users', summary.usersCount, '会員', `管理者 ${summary.adminsCount} 名を含む`, 'users', 'sand'],
    ];
    for (const [id, num, label, note, glyph, theme] of cards) {
      const card = el('article', 'stat');
      const top = el('div', 'stat-top');
      top.append(icon(glyph, `icon-box ${theme}`), document.createTextNode(label));
      const strong = el('strong', '', String(num));
      strong.id = id;
      card.append(top, strong, el('small', '', note));
      grid.append(card);
    }
    return grid;
  }

  function renderStructureRows() {
    const listWrap = $('#structure-list');
    const countEl = $('#structure-count');
    if (!listWrap) return;

    listWrap.replaceChildren();
    const query = state.query.trim().toLocaleLowerCase();
    let matchingThreads = 0;
    let renderedCats = 0;

    state.categories.forEach((cat, idx) => {
      const catMatches = !query || cat.name.toLocaleLowerCase().includes(query);
      const threads = catMatches
        ? (cat.threads || [])
        : (cat.threads || []).filter((th) => th.title.toLocaleLowerCase().includes(query));

      if (!catMatches && threads.length === 0) return;
      renderedCats += 1;
      matchingThreads += threads.length;

      const expanded = query ? !state.searchClosed.has(cat.id) : state.openCategories.has(cat.id);
      const catCard = el('section', 'category');

      const headBar = el('div', 'category-head-bar');
      const headBtn = el('button', 'category-head');
      headBtn.type = 'button';
      headBtn.dataset.action = 'expand';
      headBtn.dataset.categoryId = String(cat.id);
      headBtn.setAttribute('aria-expanded', String(expanded));
      headBtn.setAttribute('aria-controls', `cat-${cat.id}`);
      headBtn.append(
        icon('folder', categoryThemeAt(idx)),
        el('strong', '', cat.name),
        el('span', 'badge count', `${threads.length} 件`),
        icon('chevron', 'arrow')
      );

      const catActions = el('div', 'category-head-actions');
      const editCatBtn = el('button', 'icon-btn');
      editCatBtn.type = 'button';
      editCatBtn.dataset.action = 'edit-category';
      editCatBtn.dataset.categoryId = String(cat.id);
      editCatBtn.setAttribute('aria-label', `カテゴリ「${cat.name}」を編集`);
      editCatBtn.title = 'カテゴリ名・表示順を編集';
      editCatBtn.append(icon('edit'));

      const delCatBtn = el('button', 'icon-btn danger-icon');
      delCatBtn.type = 'button';
      delCatBtn.dataset.action = 'delete-category';
      delCatBtn.dataset.categoryId = String(cat.id);
      delCatBtn.setAttribute('aria-label', `カテゴリ「${cat.name}」を削除`);
      if (state.categories.length <= 1) {
        delCatBtn.disabled = true;
        delCatBtn.title = '最後の1カテゴリは削除できません（名前変更や別カテゴリ追加後に削除してください）';
      } else {
        delCatBtn.title = '空のカテゴリを削除';
      }
      delCatBtn.append(icon('trash'));

      catActions.append(editCatBtn, delCatBtn);
      headBar.append(headBtn, catActions);
      catCard.append(headBar);

      const bodyWrap = el('div', 'category-body');
      bodyWrap.id = `cat-${cat.id}`;
      bodyWrap.hidden = !expanded;

      if (threads.length === 0) {
        bodyWrap.append(el('p', 'blank', 'このカテゴリにはスレッドがありません。'));
      } else {
        for (const th of threads) {
          const row = el('div', 'thread-row');
          const nameWrap = el('div', 'thread-name');
          nameWrap.append(icon('message'), el('span', '', th.title));
          if (th.is_pinned) {
            nameWrap.append(el('span', 'badge violet', '固定'));
          }
          if (th.pinned_text && String(th.pinned_text).trim() !== '') {
            nameWrap.append(el('span', 'badge count', '案内あり'));
          }

          const countSpan = el('span', 'thread-count', `${th.post_count ?? 0} 投稿`);

          const thActions = el('div', 'thread-actions');
          const modBtn = el('button', 'icon-btn');
          modBtn.type = 'button';
          modBtn.dataset.action = 'open-thread-posts';
          modBtn.dataset.threadId = String(th.id);
          modBtn.setAttribute('aria-label', `${th.title} の投稿を管理`);
          modBtn.title = '投稿管理を開く';
          modBtn.append(icon('eye'));

          const editBtn = el('button', 'icon-btn');
          editBtn.type = 'button';
          editBtn.dataset.action = 'edit-thread';
          editBtn.dataset.threadId = String(th.id);
          editBtn.setAttribute('aria-label', `${th.title} を編集`);
          editBtn.title = 'タイトル・案内文・表示順・固定を編集';
          editBtn.append(icon('edit'));

          const purgeBtn = el('button', 'icon-btn danger-icon');
          purgeBtn.type = 'button';
          purgeBtn.dataset.action = 'purge-thread';
          purgeBtn.dataset.threadId = String(th.id);
          purgeBtn.setAttribute('aria-label', `${th.title} を物理削除`);
          purgeBtn.title = 'スレッドを物理削除';
          purgeBtn.append(icon('trash'));

          thActions.append(modBtn, editBtn, purgeBtn);
          row.append(nameWrap, countSpan, thActions);
          bodyWrap.append(row);
        }
      }

      catCard.append(bodyWrap);
      listWrap.append(catCard);
    });

    if (renderedCats === 0) {
      listWrap.append(el('p', 'blank', query ? '検索条件に一致する項目はありません。' : 'カテゴリが登録されていません。'));
    }
    if (countEl) {
      countEl.textContent = (query ? '検索結果 ' : '全 ') + `${matchingThreads} 件のスレッド`;
    }
  }

  function buildStructurePanel() {
    const panel = el('section', 'panel');
    panel.setAttribute('aria-labelledby', 'structure-title');

    const head = el('div', 'panel-head');
    const headLeft = el('div');
    const h2 = el('h2', '', 'カテゴリ・スレッド');
    h2.id = 'structure-title';
    headLeft.append(h2, el('p', '', 'カテゴリを開いて、スレッドの案内や表示順を編集できます。'));
    head.append(headLeft);

    const searchWrap = el('div', 'search-wrap');
    const searchInput = el('input');
    searchInput.id = 'structure-search';
    searchInput.type = 'search';
    searchInput.placeholder = 'カテゴリ・スレッドを検索';
    searchInput.value = state.query;
    searchInput.setAttribute('aria-label', 'カテゴリ・スレッドを検索');
    searchWrap.append(icon('search'), searchInput);

    const listWrap = el('div');
    listWrap.id = 'structure-list';

    const footer = el('div', 'panel-footer');
    const countSpan = el('span');
    countSpan.id = 'structure-count';
    countSpan.setAttribute('aria-live', 'polite');

    const addThBtn = el('button', 'link-btn');
    addThBtn.type = 'button';
    addThBtn.dataset.action = 'new-thread';
    addThBtn.disabled = state.categories.length === 0;
    addThBtn.append(document.createTextNode('スレッドを追加'), icon('arrow'));

    footer.append(countSpan, addThBtn);
    panel.append(head, searchWrap, listWrap, footer);
    return panel;
  }

  function formatAuditSummary(row) {
    const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
    const parts = [`${row.targetType}#${row.targetId}`, `${row.actorUsername} (${row.actorType})`];
    if (detail.title) parts.push(`「${detail.title}」`);
    else if (detail.afterTitle) parts.push(`「${detail.afterTitle}」`);
    else if (detail.name) parts.push(`「${detail.name}」`);
    else if (detail.afterName) parts.push(`「${detail.afterName}」`);
    else if (detail.username) parts.push(`@${detail.username}`);
    return parts.join(' · ');
  }

  function buildAuditItem(row, includeDetailJson = false) {
    const meta = AUDIT_ACTION_META[row.action] || { label: row.action, icon: 'log', theme: 'violet' };
    const li = el('li');
    const info = el('div', 'activity-info');
    const titleStr = includeDetailJson ? `${meta.label} (${row.action})` : meta.label;
    info.append(el('strong', '', titleStr), el('span', '', formatAuditSummary(row)));
    if (includeDetailJson) {
      info.append(el('span', 'activity-detail', `詳細: ${JSON.stringify(row.detail || {})}`));
    }
    const timeEl = el('time', '', formatTime(row.createdAt));
    if (row.createdAt) timeEl.dateTime = row.createdAt;
    li.append(icon(meta.icon, `icon-box ${meta.theme}`), info, timeEl);
    return li;
  }

  function renderAuditList(targetListEl = null, targetEmptyEl = null, targetMoreBtn = null, logsOverride = null) {
    const list = targetListEl || $('#audit-list');
    if (!list) return;
    const isFull = list.id === 'audit-list';
    const items = logsOverride || (isFull ? state.auditLogs : state.recentAuditLogs.slice(0, 4));
    list.replaceChildren();

    const emptyEl = targetEmptyEl || (isFull ? $('#audit-empty') : $('#recent-audit-empty'));
    if (items.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
    } else {
      if (emptyEl) emptyEl.hidden = true;
      for (const row of items) {
        list.append(buildAuditItem(row, isFull));
      }
    }

    const moreBtn = targetMoreBtn || $('#audit-more-btn');
    if (moreBtn && isFull) {
      moreBtn.hidden = !state.auditHasMore;
    }
  }

  function buildActivityPanel(full = false) {
    const panel = el('section', 'panel activity-panel');
    panel.setAttribute('aria-labelledby', 'activity-title');

    const head = el('div', 'panel-head');
    const left = el('div');
    const h2 = el('h2', '', full ? '操作履歴' : '最近の操作');
    h2.id = 'activity-title';
    left.append(h2, el('p', '', 'Web管理 (admin_web) と CLI 操作の記録'));

    if (full) {
      head.append(left, makeBtn('最新を取得', 'audit-reload', 'refresh', 'secondary', { id: 'audit-reload-btn' }));
    } else {
      head.append(left, icon('log', 'icon-box violet'));
    }

    const list = el('ul', 'activity');
    list.id = full ? 'audit-list' : 'recent-audit-list';
    const emptyNote = el('p', 'blank', '監査ログはまだありません。');
    emptyNote.id = full ? 'audit-empty' : 'recent-audit-empty';
    emptyNote.hidden = true;

    const footer = el('div', 'panel-footer');
    let moreBtn = null;
    if (full) {
      moreBtn = makeBtn('過去のログをさらに読み込む', 'audit-more', 'arrow', 'secondary', { id: 'audit-more-btn' });
      moreBtn.hidden = !state.auditHasMore;
      footer.append(moreBtn);
    } else {
      const openAuditBtn = el('button', 'link-btn');
      openAuditBtn.type = 'button';
      openAuditBtn.dataset.page = 'audit';
      openAuditBtn.append(document.createTextNode('監査ログを開く'), icon('arrow'));
      footer.append(openAuditBtn);
    }

    renderAuditList(list, emptyNote, moreBtn, full ? state.auditLogs : state.recentAuditLogs.slice(0, 4));
    panel.append(head, list, emptyNote, footer);
    return panel;
  }

  function renderModPosts() {
    const list = $('#mod-posts-list');
    if (!list) return;
    list.replaceChildren();

    if (!state.selectedModThreadId) {
      list.append(el('p', 'blank', 'スレッドが選択されていません。'));
      return;
    }
    if (state.modPostsLoading) {
      list.append(el('p', 'blank', '投稿を読み込み中...'));
      return;
    }
    if (state.modPostsError) {
      list.append(el('p', 'blank form-error', state.modPostsError));
      return;
    }

    const visiblePosts = state.modPosts.filter((post) => {
      if (state.postFilter === 'visible') return !post.is_deleted;
      if (state.postFilter === 'hidden') return Boolean(post.is_deleted);
      return true;
    });

    if (visiblePosts.length === 0) {
      list.append(el('p', 'blank', '該当する投稿はありません。'));
      return;
    }

    for (const post of visiblePosts) {
      const row = el('div', `wide-row${post.is_deleted ? ' is-deleted' : ''}`);
      const mainCol = el('div', 'wide-row-main');
      mainCol.append(el('strong', '', post.content));

      const metaParts = [
        `#${post.id}`,
        `${post.author_name} (ID:${post.visitor_id})`,
        formatTime(post.created_at),
        post.is_deleted ? '非表示' : '表示中',
      ];
      if (post.is_member) metaParts.push('会員');
      if (post.is_pinned) metaParts.push('固定');
      if (post.parent_id) metaParts.push(`返信先:#${post.parent_id}`);
      mainCol.append(el('small', '', metaParts.join(' · ')));

      const actions = el('div', 'panel-actions');
      const pinBtn = makeBtn(
        post.is_pinned ? '固定を解除' : '固定',
        'toggle-pin-post',
        'pin',
        'secondary',
        { 'data-post-id': post.id, disabled: Boolean(post.is_deleted) }
      );
      const hideBtn = makeBtn(
        post.is_deleted ? '非表示済み' : '非表示',
        'hide-post',
        'eye',
        post.is_deleted ? 'secondary' : 'danger',
        { 'data-post-id': post.id, disabled: Boolean(post.is_deleted) }
      );

      actions.append(pinBtn, hideBtn);
      row.append(mainCol, actions);
      list.append(row);
    }
  }

  function buildPostsPage() {
    ensureValidSelectedModThread();
    const panel = el('section', 'panel');
    panel.setAttribute('aria-labelledby', 'posts-mod-heading');

    const head = el('div', 'panel-head');
    const headLeft = el('div');
    const h2 = el('h2', '', 'スレッド別 投稿一覧');
    h2.id = 'posts-mod-heading';
    headLeft.append(h2, el('p', '', 'スレッドを選び、投稿のピン留めや非表示（論理削除）を切り替えます。'));
    head.append(headLeft, makeBtn('読み込み直す', 'mod-reload', 'refresh', 'secondary', { id: 'mod-posts-reload' }));

    const toolbar = el('div', 'posts-toolbar');

    const thLabel = el('label', 'toolbar-field toolbar-field-thread');
    thLabel.setAttribute('for', 'mod-thread-select');
    thLabel.append(el('span', '', '対象スレッド'));
    const thSelect = el('select');
    thSelect.id = 'mod-thread-select';
    const flat = allThreadsFlat();
    if (flat.length === 0) {
      const opt = el('option', '', 'スレッドがありません');
      opt.value = '';
      thSelect.append(opt);
    } else {
      for (const th of flat) {
        const opt = el('option', '', `[${th.categoryName}] ${th.title} (投稿 ${th.post_count ?? 0}件)`);
        opt.value = String(th.id);
        thSelect.append(opt);
      }
      if (state.selectedModThreadId) {
        thSelect.value = String(state.selectedModThreadId);
      }
    }
    thLabel.append(thSelect);

    const filterLabel = el('label', 'toolbar-field toolbar-field-filter');
    filterLabel.setAttribute('for', 'post-filter');
    filterLabel.append(el('span', '', '表示状態'));
    const filterSelect = el('select');
    filterSelect.id = 'post-filter';
    for (const [val, label] of [['all', 'すべて'], ['visible', '表示中'], ['hidden', '非表示']]) {
      const opt = el('option', '', label);
      opt.value = val;
      if (state.postFilter === val) opt.selected = true;
      filterSelect.append(opt);
    }
    filterLabel.append(filterSelect);
    toolbar.append(thLabel, filterLabel);

    const listWrap = el('div', 'wide-list');
    listWrap.id = 'mod-posts-list';

    panel.append(head, toolbar, listWrap);
    return panel;
  }

  function renderUsersTable() {
    const tbody = $('#users-table-body');
    if (!tbody) return;
    tbody.replaceChildren();

    const totalLabel = $('#users-total-label');
    if (totalLabel) totalLabel.textContent = `全 ${state.usersTotal} 件`;
    const startIdx = state.usersTotal === 0 ? 0 : state.usersOffset + 1;
    const endIdx = state.usersOffset + state.users.length;
    const pageInfo = $('#users-page-info');
    if (pageInfo) pageInfo.textContent = `${startIdx}〜${endIdx} / ${state.usersTotal} 件`;
    const prevBtn = $('#users-prev-btn');
    const nextBtn = $('#users-next-btn');
    if (prevBtn) prevBtn.disabled = state.usersOffset <= 0;
    if (nextBtn) nextBtn.disabled = endIdx >= state.usersTotal;

    if (state.users.length === 0) {
      const tr = el('tr');
      const td = el('td', '', '表示するユーザーがいません。');
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
      return;
    }

    for (const u of state.users) {
      const tr = el('tr');
      const roleTd = el('td');
      roleTd.append(
        el(
          'span',
          `badge ${u.role === 'admin' ? 'violet' : 'count'}`,
          u.role === 'admin' ? '管理者 (admin)' : '一般会員 (user)'
        )
      );
      tr.append(
        el('td', '', String(u.id)),
        el('td', '', u.username),
        roleTd,
        el('td', '', u.mustChangePassword ? '要仮パスワード変更' : '有効'),
        el('td', '', `${u.activeSessions} 件`),
        el('td', '', formatTime(u.createdAt))
      );
      tbody.append(tr);
    }
  }

  function buildMembersPage() {
    const panel = el('section', 'panel');
    panel.setAttribute('aria-labelledby', 'users-list-heading');

    const head = el('div', 'panel-head');
    const left = el('div');
    const h2 = el('h2', '', '登録ユーザー一覧');
    h2.id = 'users-list-heading';
    left.append(
      h2,
      el('p', '', 'ロール変更の Web 操作は Step 2 で実装予定です。パスワード再発行は管理 CLI（moderate.js）で行います。')
    );
    const totalMeta = el('span', 'badge count', `全 ${state.usersTotal} 件`);
    totalMeta.id = 'users-total-label';
    head.append(left, totalMeta);

    const tableWrap = el('div', 'admin-table-wrap');
    const table = el('table', 'admin-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const colLabel of ['ID', 'ユーザー名', 'ロール', '状態', '有効セッション', '登録日時']) {
      const th = el('th', '', colLabel);
      th.scope = 'col';
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = el('tbody');
    tbody.id = 'users-table-body';
    table.append(thead, tbody);
    tableWrap.append(table);

    const footer = el('div', 'panel-footer');
    const prevBtn = makeBtn('← 前へ', 'users-prev', null, 'secondary', { id: 'users-prev-btn', disabled: true });
    const info = el('span', '', '-');
    info.id = 'users-page-info';
    const nextBtn = makeBtn('次へ →', 'users-next', null, 'secondary', { id: 'users-next-btn', disabled: true });
    footer.append(prevBtn, info, nextBtn);

    panel.append(head, tableWrap, footer);
    return panel;
  }

  function renderActivePage({ focusMain = false } = {}) {
    renderNavigation();
    const pageRoot = $('#page');
    if (!pageRoot) return;
    pageRoot.replaceChildren();

    const newCategoryBtn = makeBtn('カテゴリ追加', 'new-category', 'plus', 'category-cta', {
      id: 'open-new-category-btn',
    });
    const newThreadBtn = makeBtn('新規スレッド', 'new-thread', 'plus', 'primary', {
      id: 'open-new-thread-btn',
      disabled: state.categories.length === 0,
    });

    if (state.page === 'structure') {
      pageRoot.append(
        buildPageHeading('カテゴリ管理', '掲示板の構成とスレッド案内・表示順を編集します。', [newCategoryBtn, newThreadBtn]),
        buildStructurePanel()
      );
      renderStructureRows();
    } else if (state.page === 'posts') {
      pageRoot.append(
        buildPageHeading('投稿管理', '投稿のピン留めや非表示（論理削除）を管理します。'),
        buildPostsPage()
      );
      renderModPosts();
    } else if (state.page === 'members') {
      pageRoot.append(
        buildPageHeading('会員', '登録会員の表示名・ロール・セッション状態を確認します。'),
        buildMembersPage()
      );
      renderUsersTable();
    } else if (state.page === 'audit') {
      pageRoot.append(
        buildPageHeading('監査ログ', '管理操作と対象を時系列で確認します。'),
        buildActivityPanel(true)
      );
    } else {
      const cols = el('div', 'columns');
      cols.append(buildStructurePanel(), buildActivityPanel(false));
      pageRoot.append(
        buildPageHeading('掲示板管理', '掲示板の構成と最近の管理操作を確認します。', [newCategoryBtn, newThreadBtn]),
        buildStatsGrid(),
        cols
      );
      renderStructureRows();
    }

    if (focusMain) {
      $('#main')?.focus();
    }
  }

  // -------------------------------------------------------------------
  // 5. データ読込アクション（P2-1: 非同期スレッド投稿一覧の競合防止付き）
  // -------------------------------------------------------------------
  async function loadOverview() {
    const [overviewData, recentAudit] = await Promise.all([
      apiRequest('./api/admin/overview'),
      apiRequest('./api/admin/audit-logs?limit=10').catch((err) => {
        if (err && (err.status === 401 || err.status === 403)) throw err;
        return { logs: [] };
      }),
    ]);

    state.user = overviewData.user;
    state.summary = overviewData.summary;
    state.categories = overviewData.categories || [];
    state.recentAuditLogs = Array.isArray(recentAudit?.logs) ? recentAudit.logs : [];

    if (!state.initializedAccordions) {
      state.initializedAccordions = true;
      if (state.categories.length > 0) {
        state.openCategories.add(state.categories[0].id);
      }
    } else {
      const validIds = new Set(state.categories.map((c) => c.id));
      for (const id of [...state.openCategories]) {
        if (!validIds.has(id)) state.openCategories.delete(id);
      }
    }

    ensureValidSelectedModThread();
    showWorkspace();
    renderActivePage();
  }

  async function loadModThreadPosts(threadId) {
    if (state.modAbortCtrl) {
      state.modAbortCtrl.abort();
      state.modAbortCtrl = null;
    }
    const reqSeq = ++state.modPostsSeq;
    state.modPosts = [];
    state.modPostsError = '';

    if (!threadId) {
      state.modPostsLoading = false;
      renderModPosts();
      return;
    }

    // P2-1: スレッド切替直後に旧投稿カードと操作ボタンを消去し、通信完了時に連番＋ID一致を検証する
    state.modPostsLoading = true;
    renderModPosts();

    const ctrl = new AbortController();
    state.modAbortCtrl = ctrl;
    const requestedThreadId = Number(threadId);
    try {
      const data = await apiRequest(`./api/admin/threads/${requestedThreadId}/posts`, {
        signal: ctrl.signal,
      });
      if (reqSeq !== state.modPostsSeq || requestedThreadId !== Number(state.selectedModThreadId)) {
        return;
      }
      state.modPosts = data.posts || [];
      state.modPostsLoading = false;
      state.modPostsError = '';
      renderModPosts();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (reqSeq !== state.modPostsSeq || requestedThreadId !== Number(state.selectedModThreadId)) {
        return;
      }
      state.modPosts = [];
      state.modPostsLoading = false;
      state.modPostsError = err.message || '投稿一覧の読み込みに失敗しました。';
      renderModPosts();
      throw err;
    } finally {
      if (state.modAbortCtrl === ctrl) {
        state.modAbortCtrl = null;
      }
    }
  }

  async function loadUsers(offset = 0) {
    const data = await apiRequest(
      `./api/admin/users?limit=${USERS_PAGE_LIMIT}&offset=${Math.max(0, offset)}`
    );
    state.users = data.users || [];
    state.usersTotal = Number(data.total || 0);
    state.usersOffset = Number(data.offset || 0);
    renderUsersTable();
  }

  async function loadAuditLogs(append = false) {
    const query =
      append && state.auditNextBeforeId
        ? `./api/admin/audit-logs?limit=${AUDIT_PAGE_LIMIT}&before_id=${state.auditNextBeforeId}`
        : `./api/admin/audit-logs?limit=${AUDIT_PAGE_LIMIT}`;
    const data = await apiRequest(query);
    if (append) {
      state.auditLogs = [...state.auditLogs, ...(data.logs || [])];
    } else {
      state.auditLogs = data.logs || [];
    }
    state.auditHasMore = Boolean(data.hasMore);
    state.auditNextBeforeId = data.nextBeforeId || null;
    if (state.page === 'audit') {
      renderAuditList();
    }
  }

  async function switchPage(nextPage, { focusMain = false, focusNav = false } = {}) {
    state.page = SECTIONS.some(([key]) => key === nextPage) ? nextPage : 'overview';
    if (state.page !== 'structure' && state.page !== 'overview') {
      state.query = '';
    }
    showErrorBanner('');
    renderActivePage({ focusMain: focusMain && !focusNav });
    if (focusNav) {
      $(`#nav-btn-${state.page}`)?.focus();
    }

    try {
      if (state.page === 'posts' && state.selectedModThreadId) {
        await loadModThreadPosts(state.selectedModThreadId);
      } else if (state.page === 'members') {
        await loadUsers(state.usersOffset);
      } else if (state.page === 'audit') {
        await loadAuditLogs(false);
      }
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  async function refreshAllActiveData() {
    showErrorBanner('');
    await loadOverview();
    if (state.page === 'posts' && state.selectedModThreadId) {
      await loadModThreadPosts(state.selectedModThreadId);
    } else if (state.page === 'members') {
      await loadUsers(state.usersOffset);
    } else if (state.page === 'audit') {
      await loadAuditLogs(false);
    }
  }

  // -------------------------------------------------------------------
  // 6. 汎用編集・追加・非表示確認・表示設定ダイアログ (#editor)
  // -------------------------------------------------------------------
  function appendDialogField(container, labelText, controlEl) {
    const label = el('label');
    label.append(el('span', '', labelText), controlEl);
    container.append(label);
    return controlEl;
  }

  function hasOpenModalDialog() {
    return Boolean(
      $('#editor')?.open || $('#purge-thread-dialog')?.open || $('#delete-category-dialog')?.open
    );
  }

  function restoreTriggerFocus(triggerEl, triggerSelector) {
    if (hasOpenModalDialog()) return;
    if (triggerEl && triggerEl.isConnected && !triggerEl.disabled) {
      triggerEl.focus();
      return;
    }
    if (triggerSelector) {
      const restored = $(triggerSelector);
      if (restored && !restored.disabled) {
        restored.focus();
        return;
      }
    }
    $('#main')?.focus();
  }

  function isSameActiveEditorDialog(dlg) {
    return Boolean(dlg && state.dialog && state.dialog.token === dlg.token && $('#editor')?.open);
  }

  function setEditorSubmitBusy(busy, label = '保存') {
    const submitBtn = $('#dialog-submit');
    const form = $('#editor-form');
    if (submitBtn) {
      submitBtn.disabled = Boolean(busy);
      submitBtn.textContent = busy ? '送信中...' : label;
    }
    if (form) {
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function openEditorDialog(action, triggerEl) {
    const categoryId = triggerEl?.dataset?.categoryId ? Number(triggerEl.dataset.categoryId) : null;
    const threadId = triggerEl?.dataset?.threadId ? Number(triggerEl.dataset.threadId) : null;
    const postId = triggerEl?.dataset?.postId ? Number(triggerEl.dataset.postId) : null;

    const category = categoryId ? findCategoryById(categoryId) : null;
    const threadFound = threadId ? findThreadById(threadId) : null;
    const thread = threadFound?.thread || null;

    if (action === 'new-thread' && state.categories.length === 0) {
      showErrorBanner('先にカテゴリを1件以上作成してください。', true);
      return;
    }

    const submitLabel = action === 'hide-post' ? '非表示にする' : '保存';
    const token = ++state.editorDialogSeq;
    state.dialog = {
      token,
      action,
      categoryId,
      threadId,
      postId,
      submitting: false,
      submitLabel,
    };
    state.triggerEl = triggerEl || null;
    state.triggerSelector = buildFocusSelector(triggerEl);

    const content = $('#dialog-content');
    const errorEl = $('#dialog-error');
    const titleEl = $('#dialog-title');
    const submitBtn = $('#dialog-submit');
    content.replaceChildren();
    errorEl.textContent = '';

    let focusTarget = null;

    if (action === 'preferences') {
      titleEl.textContent = '表示設定';
      submitBtn.className = 'btn primary';

      const curTheme = document.documentElement.dataset.theme || 'light';
      const curFont = String(document.documentElement.dataset.font || '16');

      const themeSelect = el('select');
      themeSelect.name = 'theme';
      themeSelect.id = 'pref-theme-select';
      for (const [val, label] of THEME_LABELS) {
        const opt = el('option', '', label);
        opt.value = val;
        if (val === curTheme) opt.selected = true;
        themeSelect.append(opt);
      }

      const fontSelect = el('select');
      fontSelect.name = 'font';
      fontSelect.id = 'pref-font-select';
      for (const [val, label] of FONT_LABELS) {
        const opt = el('option', '', label);
        opt.value = String(val);
        if (String(val) === curFont) opt.selected = true;
        fontSelect.append(opt);
      }

      focusTarget = appendDialogField(content, 'カラーテーマ（CUD対応・一般画面と共有）', themeSelect);
      appendDialogField(content, '文字サイズ', fontSelect);
      content.append(el('p', 'dialog-muted-note', '設定はこのブラウザに保存され、掲示板本体と同期されます。'));
    } else if (action === 'new-category' || (action === 'edit-category' && category)) {
      titleEl.textContent = category ? `カテゴリ #${category.id} を編集` : 'カテゴリを追加';
      submitBtn.className = 'btn primary';

      const nameInput = el('input');
      nameInput.id = 'dialog-category-name';
      nameInput.name = 'name';
      nameInput.type = 'text';
      nameInput.maxLength = 30;
      nameInput.required = true;
      nameInput.value = category ? category.name : '';

      const orderInput = el('input');
      orderInput.id = 'dialog-category-order';
      orderInput.name = 'displayOrder';
      orderInput.type = 'number';
      orderInput.min = '0';
      orderInput.step = '1';
      orderInput.placeholder = category ? '' : '空欄は末尾追加';
      orderInput.value = category ? String(category.display_order ?? 0) : '';

      focusTarget = appendDialogField(content, 'カテゴリ名（1〜30文字）', nameInput);
      appendDialogField(content, '表示順（0以上の整数）', orderInput);
    } else if (action === 'hide-post' && postId) {
      const post = state.modPosts.find((p) => p.id === postId);
      titleEl.textContent = `投稿 #${postId} を非表示にしますか？`;
      submitBtn.className = 'btn danger';

      content.append(
        el('p', 'dialog-body-copy', post ? post.content : `投稿 #${postId}`),
        el('p', 'dialog-muted-note', '一般画面では本文・投稿者名が「削除されました」にマスクされ、返信ツリーは維持されます。')
      );
      focusTarget = $('#dialog-cancel-btn');
    } else {
      titleEl.textContent = thread ? `スレッド #${thread.id} を編集` : '新規スレッド';
      submitBtn.className = 'btn primary';

      if (!thread) {
        const catSelect = el('select');
        catSelect.id = 'dialog-thread-cat';
        catSelect.name = 'categoryId';
        catSelect.required = true;
        for (const cat of state.categories) {
          const opt = el('option', '', `${cat.name} (#${cat.id})`);
          opt.value = String(cat.id);
          catSelect.append(opt);
        }
        appendDialogField(content, '所属カテゴリ', catSelect);
      }

      const titleInput = el('input');
      titleInput.id = 'dialog-thread-title';
      titleInput.name = 'title';
      titleInput.type = 'text';
      titleInput.maxLength = 100;
      titleInput.required = true;
      titleInput.value = thread ? thread.title : '';

      const guideInput = el('textarea');
      guideInput.id = 'dialog-thread-pinned-text';
      guideInput.name = 'pinnedText';
      guideInput.rows = 3;
      guideInput.maxLength = 500;
      guideInput.placeholder = 'スレッド上部に表示する案内文（空欄で非表示）';
      guideInput.value = thread?.pinned_text || '';

      const orderInput = el('input');
      orderInput.id = 'dialog-thread-order';
      orderInput.name = 'displayOrder';
      orderInput.type = 'number';
      orderInput.min = '0';
      orderInput.step = '1';
      orderInput.placeholder = thread ? '' : '空欄は末尾追加';
      orderInput.value = thread ? String(thread.display_order ?? 0) : '';

      const pinSelect = el('select');
      pinSelect.id = 'dialog-thread-pinned';
      pinSelect.name = 'isPinned';
      for (const [val, label] of [['no', '固定しない'], ['yes', '一覧で優先ピン表示する']]) {
        const opt = el('option', '', label);
        opt.value = val;
        if ((val === 'yes') === Boolean(thread?.is_pinned)) {
          opt.selected = true;
        }
        pinSelect.append(opt);
      }

      focusTarget = appendDialogField(content, 'スレッドタイトル（1〜100文字）', titleInput);
      appendDialogField(content, 'スレッド案内文（空欄で非表示・500文字以内）', guideInput);
      appendDialogField(content, '表示順（0以上の整数）', orderInput);
      appendDialogField(content, 'スレッドの優先固定', pinSelect);
    }

    setEditorSubmitBusy(false, submitLabel);
    const dialog = $('#editor');
    if (dialog && typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
      focusTarget?.focus();
    }
  }

  function closeEditorDialog({ restoreFocus = true } = {}) {
    const dialog = $('#editor');
    const savedTrigger = state.triggerEl;
    const savedSelector = state.triggerSelector;
    state.dialog = null;
    state.triggerEl = null;
    state.triggerSelector = null;
    setEditorSubmitBusy(false, '保存');
    if (dialog?.open) dialog.close();
    if (restoreFocus) {
      restoreTriggerFocus(savedTrigger, savedSelector);
    }
  }

  async function handleSaveEditor(ev) {
    ev.preventDefault();
    const dlg = state.dialog;
    if (!dlg || dlg.submitting) return;

    const form = ev.currentTarget;
    const values = new FormData(form);
    const { action, categoryId, threadId, postId, submitLabel } = dlg;
    const savedTriggerSelector = state.triggerSelector;
    $('#dialog-error').textContent = '';

    if (action === 'preferences') {
      savePreferences({
        theme: String(values.get('theme') || 'light'),
        font: Number(values.get('font') || 16),
      });
      closeEditorDialog();
      notify('表示設定を保存しました。');
      return;
    }

    // 応答待ちの連打・連続Enterによる二重送信を抑止する（失敗時は編集して再送できるよう解除）
    dlg.submitting = true;
    setEditorSubmitBusy(true, submitLabel);

    try {
      let notifyMsg = '';
      let fallbackFocusSelector = savedTriggerSelector;

      if (action === 'hide-post') {
        await apiRequest(`./api/admin/posts/${postId}/delete`, {
          method: 'POST',
          body: {},
        });
        notifyMsg = `投稿 #${postId} を非表示（論理削除）にしました。`;
        fallbackFocusSelector = savedTriggerSelector || '#mod-thread-select';
      } else if (action === 'new-category') {
        const name = String(values.get('name') ?? '');
        const rawOrder = String(values.get('displayOrder') ?? '').trim();
        const body = { name };
        if (rawOrder !== '') body.displayOrder = Number(rawOrder);
        const res = await apiRequest('./api/admin/categories', { method: 'POST', body });
        state.openCategories.add(res.category.id);
        state.query = '';
        notifyMsg = `カテゴリ「${res.category.name}」を追加しました。`;
        fallbackFocusSelector = `[data-action="expand"][data-category-id="${res.category.id}"]`;
      } else if (action === 'edit-category') {
        const name = String(values.get('name') ?? '');
        const rawOrder = String(values.get('displayOrder') ?? '').trim();
        const body = { name };
        if (rawOrder !== '') body.displayOrder = Number(rawOrder);
        const res = await apiRequest(`./api/admin/categories/${categoryId}`, { method: 'PATCH', body });
        notifyMsg = `カテゴリ #${res.category.id}「${res.category.name}」を更新しました。`;
      } else if (action === 'new-thread') {
        const targetCatId = Number(values.get('categoryId'));
        const title = String(values.get('title') ?? '');
        const pinnedTextRaw = String(values.get('pinnedText') ?? '');
        const rawOrder = String(values.get('displayOrder') ?? '').trim();
        const isPinned = values.get('isPinned') === 'yes';
        const body = {
          categoryId: targetCatId,
          title,
          pinnedText: pinnedTextRaw.trim() === '' ? null : pinnedTextRaw,
          isPinned,
        };
        if (rawOrder !== '') body.displayOrder = Number(rawOrder);
        const res = await apiRequest('./api/admin/threads', { method: 'POST', body });
        state.openCategories.add(targetCatId);
        state.query = '';
        notifyMsg = `スレッド「${res.thread.title}」を作成しました。`;
        fallbackFocusSelector = `[data-action="edit-thread"][data-thread-id="${res.thread.id}"]`;
      } else if (action === 'edit-thread') {
        const title = String(values.get('title') ?? '');
        const pinnedTextRaw = String(values.get('pinnedText') ?? '');
        const rawOrder = String(values.get('displayOrder') ?? '').trim();
        const isPinned = values.get('isPinned') === 'yes';
        const body = {
          title,
          pinnedText: pinnedTextRaw.trim() === '' ? null : pinnedTextRaw,
          isPinned,
        };
        if (rawOrder !== '') body.displayOrder = Number(rawOrder);
        const res = await apiRequest(`./api/admin/threads/${threadId}`, { method: 'PATCH', body });
        notifyMsg = `スレッド #${res.thread.id}「${res.thread.title}」を保存しました。`;
      }

      dlg.submitting = false;
      if (!isSameActiveEditorDialog(dlg)) {
        if (notifyMsg) notify(notifyMsg);
        await refreshAllActiveData().catch(() => {});
        return;
      }
      closeEditorDialog({ restoreFocus: false });
      if (notifyMsg) notify(notifyMsg);
      await refreshAllActiveData();
      restoreTriggerFocus(null, fallbackFocusSelector);
    } catch (err) {
      dlg.submitting = false;
      if (!isSameActiveEditorDialog(dlg)) {
        return;
      }
      setEditorSubmitBusy(false, submitLabel);
      $('#dialog-error').textContent = err.message;
    }
  }

  // -------------------------------------------------------------------
  // 7. 専用削除確認ダイアログ（空カテゴリ削除・2段階スレッド物理削除）
  //    各ダイアログ表示ごとに世代 token と in-flight 状態を保持し、
  //    閉じる／別対象を開いた後に遅延完了した応答の誤反映を防ぐ。
  // -------------------------------------------------------------------
  function isSameActiveDeleteCatDialog(ctx) {
    return Boolean(ctx && state.deleteCatContext && state.deleteCatContext.token === ctx.token && $('#delete-category-dialog')?.open);
  }

  function setDeleteCatSubmitBusy(busy) {
    const btn = $('#delete-cat-confirm');
    const form = $('#delete-category-form');
    if (btn) {
      btn.disabled = Boolean(busy);
      btn.textContent = busy ? '削除中...' : 'カテゴリを削除する';
    }
    if (form) {
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  function openDeleteCategoryDialog(categoryId, triggerEl) {
    const cat = findCategoryById(categoryId);
    if (!cat) return;
    showErrorBanner('');
    const token = ++state.deleteCatDialogSeq;
    state.deleteCatContext = {
      token,
      categoryId: cat.id,
      name: cat.name,
      triggerEl,
      triggerSelector: buildFocusSelector(triggerEl),
      submitting: false,
    };
    $('#delete-cat-error').textContent = '';
    $('#delete-cat-message').textContent =
      `カテゴリ #${cat.id}「${cat.name}」を削除します。配下にスレッドがある場合は拒否されます。`;
    setDeleteCatSubmitBusy(false);
    const dialog = $('#delete-category-dialog');
    if (dialog && typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
      $('#delete-cat-confirm').focus();
    }
  }

  function closeDeleteCategoryDialog({ restoreFocus = true } = {}) {
    const dialog = $('#delete-category-dialog');
    const ctx = state.deleteCatContext;
    state.deleteCatContext = null;
    setDeleteCatSubmitBusy(false);
    if (dialog?.open) dialog.close();
    if (restoreFocus && ctx) {
      restoreTriggerFocus(ctx.triggerEl, ctx.triggerSelector);
    }
  }

  async function handleConfirmDeleteCategory(ev) {
    ev.preventDefault();
    const ctx = state.deleteCatContext;
    if (!ctx || ctx.submitting) return;
    ctx.submitting = true;
    setDeleteCatSubmitBusy(true);
    $('#delete-cat-error').textContent = '';
    try {
      const res = await apiRequest(`./api/admin/categories/${ctx.categoryId}`, {
        method: 'DELETE',
        body: {},
      });
      ctx.submitting = false;
      if (!isSameActiveDeleteCatDialog(ctx)) {
        notify(`カテゴリ「${res.deletedCategory.name}」を削除しました。`);
        await refreshAllActiveData().catch(() => {});
        return;
      }
      closeDeleteCategoryDialog({ restoreFocus: false });
      notify(`カテゴリ「${res.deletedCategory.name}」を削除しました。`);
      await refreshAllActiveData();
      restoreTriggerFocus(null, '#open-new-category-btn');
    } catch (err) {
      ctx.submitting = false;
      if (!isSameActiveDeleteCatDialog(ctx)) {
        return;
      }
      setDeleteCatSubmitBusy(false);
      $('#delete-cat-error').textContent = err.message;
    }
  }

  function isSameActivePurgeDialog(ctx) {
    return Boolean(ctx && state.purgeContext && state.purgeContext.token === ctx.token && $('#purge-thread-dialog')?.open);
  }

  function setPurgeSubmitBusy(busy) {
    const btn = $('#purge-confirm-btn');
    const form = $('#purge-thread-form');
    if (btn) {
      btn.disabled = Boolean(busy);
      btn.textContent = busy ? '削除処理中...' : '内容を確認して物理削除を実行';
    }
    if (form) {
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
  }

  async function openPurgeThreadDialog(threadId, triggerEl) {
    showErrorBanner('');
    if (state.purgePreviewAbortCtrl) {
      state.purgePreviewAbortCtrl.abort();
      state.purgePreviewAbortCtrl = null;
    }
    const reqSeq = ++state.purgePreviewSeq;
    const ctrl = new AbortController();
    state.purgePreviewAbortCtrl = ctrl;

    try {
      const preview = await apiRequest(`./api/admin/threads/${threadId}/delete-preview`, {
        signal: ctrl.signal,
      });
      if (reqSeq !== state.purgePreviewSeq || ctrl.signal.aborted) {
        return;
      }
      const token = ++state.purgeDialogSeq;
      state.purgeContext = {
        token,
        threadId: Number(preview.thread.id),
        title: preview.thread.title,
        expectedPostCount: Number(preview.postsCount),
        triggerEl,
        triggerSelector: buildFocusSelector(triggerEl),
        submitting: false,
      };
      $('#purge-target-title').textContent = `#${preview.thread.id}「${preview.thread.title}」`;
      $('#purge-target-count').textContent = `${preview.postsCount} 件`;
      $('#purge-confirm-input').value = '';
      $('#purge-dialog-error').textContent = '';
      setPurgeSubmitBusy(false);
      const dialog = $('#purge-thread-dialog');
      if (dialog && typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
        $('#purge-confirm-input').focus();
      }
    } catch (err) {
      if ((err && err.name === 'AbortError') || reqSeq !== state.purgePreviewSeq) {
        return;
      }
      showErrorBanner(err.message, true);
    } finally {
      if (state.purgePreviewAbortCtrl === ctrl) {
        state.purgePreviewAbortCtrl = null;
      }
    }
  }

  function closePurgeThreadDialog({ restoreFocus = true } = {}) {
    state.purgePreviewSeq += 1;
    if (state.purgePreviewAbortCtrl) {
      state.purgePreviewAbortCtrl.abort();
      state.purgePreviewAbortCtrl = null;
    }
    const dialog = $('#purge-thread-dialog');
    const ctx = state.purgeContext;
    state.purgeContext = null;
    setPurgeSubmitBusy(false);
    if (dialog?.open) dialog.close();
    if (restoreFocus && ctx) {
      restoreTriggerFocus(ctx.triggerEl, ctx.triggerSelector);
    }
  }

  async function handleConfirmPurgeThread(ev) {
    ev.preventDefault();
    const ctx = state.purgeContext;
    if (!ctx || ctx.submitting) return;
    const confirmTitle = $('#purge-confirm-input').value;
    const targetThreadId = ctx.threadId;
    const expectedPostCount = ctx.expectedPostCount;
    $('#purge-dialog-error').textContent = '';

    ctx.submitting = true;
    setPurgeSubmitBusy(true);

    try {
      const res = await apiRequest(`./api/admin/threads/${targetThreadId}`, {
        method: 'DELETE',
        body: {
          confirmTitle,
          expectedPostCount,
        },
      });
      ctx.submitting = false;
      if (!isSameActivePurgeDialog(ctx)) {
        notify(`スレッド「${res.deletedThread.title}」と投稿 ${res.deletedPostsCount} 件を削除しました。`);
        await refreshAllActiveData().catch(() => {});
        return;
      }
      closePurgeThreadDialog({ restoreFocus: false });
      notify(`スレッド「${res.deletedThread.title}」と投稿 ${res.deletedPostsCount} 件を削除しました。`);
      await refreshAllActiveData();
      restoreTriggerFocus(null, '#main');
    } catch (err) {
      ctx.submitting = false;
      if (!isSameActivePurgeDialog(ctx)) {
        return;
      }
      setPurgeSubmitBusy(false);
      if (
        err.code === 'THREAD_POST_COUNT_CHANGED' &&
        err.details &&
        Number.isSafeInteger(err.details.actualPostsCount)
      ) {
        ctx.expectedPostCount = err.details.actualPostsCount;
        $('#purge-target-count').textContent = `${err.details.actualPostsCount} 件（最新に更新済み）`;
      }
      $('#purge-dialog-error').textContent = err.message;
    }
  }

  async function handleTogglePostPin(postId, nextPinned) {
    if (state.pendingPinPostIds.has(postId)) return;
    state.pendingPinPostIds.add(postId);
    showErrorBanner('');
    const triggerBtn = $(`[data-action="toggle-pin-post"][data-post-id="${postId}"]`);
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      await apiRequest(`./api/admin/posts/${postId}/pin`, {
        method: 'POST',
        body: { pinned: nextPinned },
      });
      notify(nextPinned ? `投稿 #${postId} をピン留めしました。` : `投稿 #${postId} のピン留めを解除しました。`);
      await refreshAllActiveData();
      restoreTriggerFocus(null, `[data-action="toggle-pin-post"][data-post-id="${postId}"]`);
    } catch (err) {
      showErrorBanner(err.message, true);
    } finally {
      state.pendingPinPostIds.delete(postId);
      const curBtn = $(`[data-action="toggle-pin-post"][data-post-id="${postId}"]`);
      if (curBtn) curBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------------
  // 8. イベント登録・キーボードナビゲーション・初期化
  // -------------------------------------------------------------------
  function bindEvents() {
    $('#admin-reload-all')?.addEventListener('click', async () => {
      try {
        await refreshAllActiveData();
        notify('最新の管理データを再読込しました。');
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#navigation')?.addEventListener('keydown', (ev) => {
      const btn = ev.target.closest('.nav-btn[data-page]');
      if (!btn) return;
      const idx = SECTIONS.findIndex(([key]) => key === btn.dataset.page);
      if (idx < 0) return;

      let nextIdx = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
        nextIdx = (idx + 1) % SECTIONS.length;
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
        nextIdx = (idx - 1 + SECTIONS.length) % SECTIONS.length;
      } else if (ev.key === 'Home') {
        nextIdx = 0;
      } else if (ev.key === 'End') {
        nextIdx = SECTIONS.length - 1;
      }
      if (nextIdx >= 0) {
        ev.preventDefault();
        switchPage(SECTIONS[nextIdx][0], { focusNav: true });
      }
    });

    document.addEventListener('input', (ev) => {
      if (ev.target.id === 'structure-search') {
        state.query = ev.target.value;
        state.searchClosed.clear();
        renderStructureRows();
      }
    });

    document.addEventListener('change', async (ev) => {
      if (ev.target.id === 'mod-thread-select') {
        state.selectedModThreadId = ev.target.value ? Number(ev.target.value) : null;
        try {
          await loadModThreadPosts(state.selectedModThreadId);
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }
      if (ev.target.id === 'post-filter') {
        state.postFilter = ev.target.value;
        renderModPosts();
      }
    });

    document.addEventListener('click', async (ev) => {
      const control = ev.target.closest('[data-action],[data-page]');
      if (!control) return;

      if (control.dataset.page) {
        await switchPage(control.dataset.page, { focusMain: true });
        return;
      }

      const action = control.dataset.action;
      if (action === 'expand') {
        const catId = Number(control.dataset.categoryId);
        const searching = Boolean(state.query.trim());
        const toggled = searching ? state.searchClosed : state.openCategories;
        if (toggled.has(catId)) toggled.delete(catId);
        else toggled.add(catId);
        const expanded = searching ? !toggled.has(catId) : toggled.has(catId);
        control.setAttribute('aria-expanded', String(expanded));
        const body = $(`#cat-${catId}`);
        if (body) body.hidden = !expanded;
        return;
      }

      if (action === 'theme') {
        const cur = document.documentElement.dataset.theme || 'light';
        const nextTheme = cur === 'dark' || cur === 'ud-dark'
          ? (cur === 'ud-dark' ? 'ud-light' : 'light')
          : (cur === 'ud-light' ? 'ud-dark' : 'dark');
        savePreferences({ theme: nextTheme });
        return;
      }

      if (action === 'close') {
        closeEditorDialog();
        return;
      }

      if (action === 'open-thread-posts') {
        const threadId = Number(control.dataset.threadId);
        state.selectedModThreadId = threadId;
        await switchPage('posts', { focusMain: true });
        return;
      }

      if (action === 'delete-category') {
        openDeleteCategoryDialog(Number(control.dataset.categoryId), control);
        return;
      }

      if (action === 'purge-thread') {
        await openPurgeThreadDialog(Number(control.dataset.threadId), control);
        return;
      }

      if (action === 'mod-reload') {
        try {
          await loadModThreadPosts(state.selectedModThreadId);
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }

      if (action === 'toggle-pin-post') {
        const postId = Number(control.dataset.postId);
        const post = state.modPosts.find((p) => p.id === postId);
        if (post) {
          await handleTogglePostPin(postId, !post.is_pinned);
        }
        return;
      }

      if (action === 'users-prev') {
        try {
          await loadUsers(Math.max(0, state.usersOffset - USERS_PAGE_LIMIT));
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }

      if (action === 'users-next') {
        try {
          await loadUsers(state.usersOffset + USERS_PAGE_LIMIT);
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }

      if (action === 'audit-reload') {
        try {
          await loadAuditLogs(false);
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }

      if (action === 'audit-more') {
        try {
          await loadAuditLogs(true);
        } catch (err) {
          showErrorBanner(err.message, true);
        }
        return;
      }

      if (
        action === 'preferences' ||
        action === 'new-category' ||
        action === 'edit-category' ||
        action === 'new-thread' ||
        action === 'edit-thread' ||
        action === 'hide-post'
      ) {
        openEditorDialog(action, control);
      }
    });

    $('#editor-form')?.addEventListener('submit', handleSaveEditor);
    $('#editor')?.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      closeEditorDialog();
    });

    $('#purge-thread-form')?.addEventListener('submit', handleConfirmPurgeThread);
    $('#purge-cancel-btn')?.addEventListener('click', () => closePurgeThreadDialog());
    $('#purge-dialog-close')?.addEventListener('click', () => closePurgeThreadDialog());
    $('#purge-thread-dialog')?.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      closePurgeThreadDialog();
    });

    $('#delete-category-form')?.addEventListener('submit', handleConfirmDeleteCategory);
    $('#delete-cat-cancel')?.addEventListener('click', () => closeDeleteCategoryDialog());
    $('#delete-cat-close')?.addEventListener('click', () => closeDeleteCategoryDialog());
    $('#delete-category-dialog')?.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      closeDeleteCategoryDialog();
    });
  }

  async function init() {
    applyStoredPreferences();
    bindEvents();
    try {
      await loadOverview();
    } catch {
      if ($('#admin-auth-gate').hidden === false && $('#admin-gate-message').textContent.includes('確認しています')) {
        showAuthGate('管理画面の読み込みに失敗しました。通信状況を確認して再度お試しください。');
      }
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
