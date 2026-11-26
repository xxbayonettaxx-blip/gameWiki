'use strict';

/**
 * =====================================================================
 * public/admin.js
 * 役割：管理画面 (admin.html) の対話ロジック・API連携・キーボードA11y制御
 * 方針：
 *   - innerHTML は一切使用しない（createElement + textContent のみでXSSを遮断）。
 *   - すべてのAPI通信・戻りリンクは './' 相対パスを使用し、'/board/' 配備と両立する。
 *   - 非管理者への401/403応答時は管理領域を隠したまま認証ゲートのみ表示する。
 *   - 破壊的操作（スレッド物理削除）は確定直前件数不一致(409)時に最新件数を再表示し再確認を促す。
 * =====================================================================
 */

(() => {
  const PREF_KEY = 'community-board-prefs-v1';
  const ALLOWED_THEMES = ['light', 'dark', 'paper', 'ud-light', 'ud-dark'];
  const ALLOWED_FONTS = [14, 16, 18];
  const USERS_PAGE_LIMIT = 50;
  const AUDIT_PAGE_LIMIT = 50;

  const $ = (sel) => document.querySelector(sel);

  const state = {
    user: null,
    summary: null,
    categories: [],
    activeTab: 'structure',
    selectedModThreadId: null,
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
    purgeContext: null, // { threadId, title, expectedPostCount, triggerEl }
    deleteCatContext: null, // { categoryId, name, triggerEl }
    toastTimer: null,
  };

  // -------------------------------------------------------------------
  // 1. 共通表示設定・時刻整形・DOM構築・通知ヘルパー
  // -------------------------------------------------------------------
  function applyStoredPreferences() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return;
      if (ALLOWED_THEMES.includes(saved.theme)) {
        document.documentElement.dataset.theme = saved.theme;
      }
      if (ALLOWED_FONTS.includes(saved.font)) {
        document.documentElement.dataset.font = String(saved.font);
      }
    } catch {
      // ignore localStorage restrictions
    }
  }

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

  function notify(message) {
    window.clearTimeout(state.toastTimer);
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    state.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3400);
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
      badge.textContent = `管理者: ${state.user.username}`;
      badge.hidden = false;
    }
  }

  // -------------------------------------------------------------------
  // 2. 相対パス JSON API 呼び出し共通ラッパー
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
  // 3. 全体再描画・各パネル描画
  // -------------------------------------------------------------------
  function renderSummary() {
    if (!state.summary) return;
    $('#stat-categories').textContent = String(state.summary.categoriesCount);
    $('#stat-threads').textContent = String(state.summary.threadsCount);
    $('#stat-posts').textContent = String(state.summary.postsCount);
    $('#stat-users').textContent = `${state.summary.usersCount} 名 (管理 ${state.summary.adminsCount})`;
  }

  function renderThreadSelectors() {
    const catSelect = $('#new-thread-cat');
    const modSelect = $('#mod-thread-select');
    const prevCatVal = catSelect.value;
    const prevModVal = state.selectedModThreadId ? String(state.selectedModThreadId) : modSelect.value;

    catSelect.replaceChildren();
    modSelect.replaceChildren();

    const allThreads = [];
    for (const cat of state.categories) {
      const opt = el('option', '', `${cat.name} (#${cat.id})`);
      opt.value = String(cat.id);
      catSelect.append(opt);

      for (const th of cat.threads || []) {
        allThreads.push({ categoryName: cat.name, ...th });
        const tOpt = el('option', '', `[${cat.name}] ${th.title} (投稿 ${th.post_count}件)`);
        tOpt.value = String(th.id);
        modSelect.append(tOpt);
      }
    }

    if (prevCatVal && Array.from(catSelect.options).some((o) => o.value === prevCatVal)) {
      catSelect.value = prevCatVal;
    }
    if (allThreads.length === 0) {
      const emptyOpt = el('option', '', 'スレッドがありません');
      emptyOpt.value = '';
      modSelect.append(emptyOpt);
      state.selectedModThreadId = null;
    } else if (prevModVal && allThreads.some((t) => String(t.id) === prevModVal)) {
      modSelect.value = prevModVal;
      state.selectedModThreadId = Number(prevModVal);
    } else {
      state.selectedModThreadId = allThreads[0].id;
      modSelect.value = String(allThreads[0].id);
    }

    $('#create-thread-submit').disabled = state.categories.length === 0;
  }

  function renderStructureList() {
    const container = $('#structure-list');
    container.replaceChildren();

    if (state.categories.length === 0) {
      container.append(el('p', 'admin-help', 'カテゴリが登録されていません。'));
      return;
    }

    for (const cat of state.categories) {
      const catCard = el('article', 'structure-cat-card');
      catCard.append(el('h3', 'structure-cat-heading', `カテゴリ #${cat.id}：${cat.name}`));

      const header = el('div', 'structure-cat-header');
      const editRow = el('div', 'structure-edit-row');

      const nameLabel = el('label', 'admin-field');
      nameLabel.append(el('span', '', '名称'));
      const nameInput = el('input');
      nameInput.type = 'text';
      nameInput.maxLength = 30;
      nameInput.value = cat.name;
      nameInput.dataset.catNameInput = String(cat.id);
      nameLabel.append(nameInput);

      const orderLabel = el('label', 'admin-field field-order');
      orderLabel.append(el('span', '', '表示順'));
      const orderInput = el('input');
      orderInput.type = 'number';
      orderInput.min = '0';
      orderInput.step = '1';
      orderInput.value = String(cat.display_order ?? 0);
      orderInput.dataset.catOrderInput = String(cat.id);
      orderLabel.append(orderInput);

      editRow.append(nameLabel, orderLabel);

      const btnGroup = el('div', 'structure-btn-group');
      const saveBtn = el('button', 'button-secondary button-small', 'カテゴリ保存');
      saveBtn.type = 'button';
      saveBtn.dataset.action = 'save-category';
      saveBtn.dataset.categoryId = String(cat.id);
      saveBtn.addEventListener('click', () => handleUpdateCategory(cat.id, nameInput.value, orderInput.value));

      const delBtn = el('button', 'button-danger', 'カテゴリ削除');
      delBtn.type = 'button';
      delBtn.dataset.action = 'delete-category';
      delBtn.dataset.categoryId = String(cat.id);
      if (state.categories.length <= 1) {
        delBtn.disabled = true;
        delBtn.title = '最後の1カテゴリは削除できません（名前変更や別カテゴリ追加後に削除してください）';
      } else {
        delBtn.addEventListener('click', (ev) => openDeleteCategoryDialog(cat, ev.currentTarget));
      }

      btnGroup.append(saveBtn, delBtn);
      header.append(editRow, btnGroup);
      catCard.append(header);

      const thList = el('div', 'structure-thread-list');
      const threads = cat.threads || [];
      if (threads.length === 0) {
        thList.append(el('p', 'admin-help', 'このカテゴリにはスレッドがありません。'));
      } else {
        for (const th of threads) {
          const thBox = el('div', 'structure-thread-item');

          const meta = el('div', 'structure-thread-meta');
          meta.append(
            el('strong', '', `スレッド #${th.id}：${th.title}`),
            el('span', '', `投稿数: ${th.post_count}件`),
            el('span', '', `最終更新: ${formatTime(th.latest_post_at)}`)
          );

          const thFields = el('div', 'structure-edit-row');

          const thTitleLabel = el('label', 'admin-field');
          thTitleLabel.append(el('span', '', 'タイトル'));
          const thTitleInput = el('input');
          thTitleInput.type = 'text';
          thTitleInput.maxLength = 100;
          thTitleInput.value = th.title;
          thTitleInput.dataset.threadTitleInput = String(th.id);
          thTitleLabel.append(thTitleInput);

          const thOrderLabel = el('label', 'admin-field field-order');
          thOrderLabel.append(el('span', '', '表示順'));
          const thOrderInput = el('input');
          thOrderInput.type = 'number';
          thOrderInput.min = '0';
          thOrderInput.step = '1';
          thOrderInput.value = String(th.display_order ?? 0);
          thOrderInput.dataset.threadOrderInput = String(th.id);
          thOrderLabel.append(thOrderInput);

          const thPinLabel = el('label', 'admin-checkbox-field');
          const thPinInput = el('input');
          thPinInput.type = 'checkbox';
          thPinInput.checked = Boolean(th.is_pinned);
          thPinInput.dataset.threadPinnedInput = String(th.id);
          thPinLabel.append(thPinInput, el('span', '', '優先ピン'));

          thFields.append(thTitleLabel, thOrderLabel, thPinLabel);

          const thGuideLabel = el('label', 'admin-field');
          thGuideLabel.append(el('span', '', 'スレッド案内文（空欄で非表示）'));
          const thGuideInput = el('textarea');
          thGuideInput.rows = 2;
          thGuideInput.maxLength = 500;
          thGuideInput.value = th.pinned_text || '';
          thGuideInput.dataset.threadPinnedTextInput = String(th.id);
          thGuideLabel.append(thGuideInput);

          const thBtns = el('div', 'structure-btn-group');
          const thSaveBtn = el('button', 'button-secondary button-small', 'スレッド保存');
          thSaveBtn.type = 'button';
          thSaveBtn.dataset.action = 'save-thread';
          thSaveBtn.dataset.threadId = String(th.id);
          thSaveBtn.addEventListener('click', () =>
            handleUpdateThread(th.id, {
              title: thTitleInput.value,
              displayOrder: thOrderInput.value,
              isPinned: thPinInput.checked,
              pinnedText: thGuideInput.value,
            })
          );

          const thModBtn = el('button', 'button-secondary button-small', '投稿管理を開く');
          thModBtn.type = 'button';
          thModBtn.addEventListener('click', async () => {
            state.selectedModThreadId = th.id;
            $('#mod-thread-select').value = String(th.id);
            switchTab('posts');
            try {
              await loadModThreadPosts(th.id);
            } catch (err) {
              showErrorBanner(err.message, true);
            }
          });

          const thPurgeBtn = el('button', 'button-danger', '⚠ 物理削除');
          thPurgeBtn.type = 'button';
          thPurgeBtn.dataset.action = 'purge-thread';
          thPurgeBtn.dataset.threadId = String(th.id);
          thPurgeBtn.addEventListener('click', (ev) => openPurgeThreadDialog(th.id, ev.currentTarget));

          thBtns.append(thSaveBtn, thModBtn, thPurgeBtn);
          thBox.append(meta, thFields, thGuideLabel, thBtns);
          thList.append(thBox);
        }
      }

      catCard.append(thList);
      container.append(catCard);
    }
  }

  function renderModPosts() {
    const list = $('#mod-posts-list');
    list.replaceChildren();

    if (!state.selectedModThreadId) {
      list.append(el('p', 'admin-help', 'スレッドが選択されていません。'));
      return;
    }
    if (state.modPostsLoading) {
      list.append(el('p', 'admin-help', '投稿を読み込み中...'));
      return;
    }
    if (state.modPostsError) {
      list.append(el('p', 'form-error', state.modPostsError));
      return;
    }
    if (state.modPosts.length === 0) {
      list.append(el('p', 'admin-help', 'このスレッドにはまだ投稿がありません。'));
      return;
    }

    for (const post of state.modPosts) {
      const card = el('article', `mod-post-card${post.is_deleted ? ' is-deleted' : ''}`);
      const head = el('div', 'mod-post-head');
      const left = el('div', '');
      const statusTags = [];
      if (post.is_member) statusTags.push('会員');
      if (post.is_pinned) statusTags.push('ピン留め中');
      if (post.is_deleted) statusTags.push('削除済み');
      if (post.parent_id) statusTags.push(`返信先:#${post.parent_id}`);
      const tagStr = statusTags.length ? ` [${statusTags.join(' / ')}]` : '';
      left.textContent = `#${post.id} ${post.author_name} (ID:${post.visitor_id})${tagStr}`;
      head.append(left, el('span', '', formatTime(post.created_at)));

      const body = el('p', 'mod-post-body', post.content);
      const actions = el('div', 'structure-btn-group');

      const pinBtn = el(
        'button',
        'button-secondary button-small',
        post.is_pinned ? 'ピン留め解除' : 'ピン留めする'
      );
      pinBtn.type = 'button';
      pinBtn.disabled = Boolean(post.is_deleted);
      pinBtn.dataset.action = 'toggle-pin-post';
      pinBtn.dataset.postId = String(post.id);
      pinBtn.addEventListener('click', () => handleTogglePostPin(post.id, !post.is_pinned));

      const delBtn = el(
        'button',
        'button-danger',
        post.is_deleted ? '論理削除済み' : '非表示 (論理削除)'
      );
      delBtn.type = 'button';
      delBtn.disabled = Boolean(post.is_deleted);
      delBtn.dataset.action = 'soft-delete-post';
      delBtn.dataset.postId = String(post.id);
      delBtn.addEventListener('click', () => handleSoftDeletePost(post.id));

      actions.append(pinBtn, delBtn);
      card.append(head, body, actions);
      list.append(card);
    }
  }

  function renderUsersTable() {
    const tbody = $('#users-table-body');
    tbody.replaceChildren();

    $('#users-total-label').textContent = `全 ${state.usersTotal} 件`;
    const startIdx = state.usersTotal === 0 ? 0 : state.usersOffset + 1;
    const endIdx = state.usersOffset + state.users.length;
    $('#users-page-info').textContent = `${startIdx}〜${endIdx} / ${state.usersTotal} 件`;
    $('#users-prev-btn').disabled = state.usersOffset <= 0;
    $('#users-next-btn').disabled = endIdx >= state.usersTotal;

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
      tr.append(
        el('td', '', String(u.id)),
        el('td', '', u.username),
        el('td', '', u.role === 'admin' ? '管理者 (admin)' : '一般会員 (user)'),
        el('td', '', u.mustChangePassword ? '要仮パスワード変更' : '有効'),
        el('td', '', `${u.activeSessions} 件`),
        el('td', '', formatTime(u.createdAt))
      );
      tbody.append(tr);
    }
  }

  function renderAuditTable() {
    const tbody = $('#audit-table-body');
    tbody.replaceChildren();

    if (state.auditLogs.length === 0) {
      const tr = el('tr');
      const td = el('td', '', '監査ログはまだありません。');
      td.colSpan = 6;
      tr.append(td);
      tbody.append(tr);
    } else {
      for (const row of state.auditLogs) {
        const tr = el('tr');
        const actorStr = `${row.actorUsername} (${row.actorType})`;
        const targetStr = `${row.targetType}#${row.targetId}`;
        const detailStr = JSON.stringify(row.detail || {});
        tr.append(
          el('td', '', String(row.id)),
          el('td', '', formatTime(row.createdAt)),
          el('td', '', actorStr),
          el('td', '', row.action),
          el('td', '', targetStr),
          el('td', '', detailStr)
        );
        tbody.append(tr);
      }
    }

    const moreBtn = $('#audit-more-btn');
    moreBtn.hidden = !state.auditHasMore;
  }

  // -------------------------------------------------------------------
  // 4. データ読込アクション
  // -------------------------------------------------------------------
  async function loadOverview() {
    const data = await apiRequest('./api/admin/overview');
    state.user = data.user;
    state.summary = data.summary;
    state.categories = data.categories || [];
    showWorkspace();
    renderSummary();
    renderThreadSelectors();
    renderStructureList();
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

    // P2-1: スレッド切替時は旧一覧と操作ボタンを即時消去し、最新要求かつ選択中スレッド一致時のみ描画する
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
    renderAuditTable();
  }

  async function refreshAllActiveData() {
    showErrorBanner('');
    await loadOverview();
    if (state.activeTab === 'posts' && state.selectedModThreadId) {
      await loadModThreadPosts(state.selectedModThreadId);
    } else if (state.activeTab === 'users') {
      await loadUsers(state.usersOffset);
    } else if (state.activeTab === 'audit') {
      await loadAuditLogs(false);
    }
  }

  // -------------------------------------------------------------------
  // 5. 更新系操作ハンドラ
  // -------------------------------------------------------------------
  async function handleCreateCategory(ev) {
    ev.preventDefault();
    showErrorBanner('');
    const name = $('#new-cat-name').value;
    const rawOrder = $('#new-cat-order').value.trim();
    const body = { name };
    if (rawOrder !== '') {
      body.displayOrder = Number(rawOrder);
    }
    try {
      const res = await apiRequest('./api/admin/categories', { method: 'POST', body });
      $('#new-cat-name').value = '';
      $('#new-cat-order').value = '';
      notify(`カテゴリ「${res.category.name}」を追加しました。`);
      await loadOverview();
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  async function handleUpdateCategory(categoryId, name, rawOrder) {
    showErrorBanner('');
    const body = { name };
    if (String(rawOrder).trim() !== '') {
      body.displayOrder = Number(rawOrder);
    }
    try {
      const res = await apiRequest(`./api/admin/categories/${categoryId}`, {
        method: 'PATCH',
        body,
      });
      notify(`カテゴリ #${res.category.id}「${res.category.name}」を更新しました。`);
      await loadOverview();
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  function openDeleteCategoryDialog(cat, triggerEl) {
    showErrorBanner('');
    state.deleteCatContext = { categoryId: cat.id, name: cat.name, triggerEl };
    $('#delete-cat-error').textContent = '';
    $('#delete-cat-message').textContent =
      `カテゴリ #${cat.id}「${cat.name}」を削除します。配下にスレッドがある場合は拒否されます。`;
    const dialog = $('#delete-category-dialog');
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      $('#delete-cat-confirm').focus();
    }
  }

  function closeDeleteCategoryDialog() {
    const dialog = $('#delete-category-dialog');
    if (dialog.open) dialog.close();
    const trigger = state.deleteCatContext?.triggerEl;
    state.deleteCatContext = null;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  async function handleConfirmDeleteCategory(ev) {
    ev.preventDefault();
    if (!state.deleteCatContext) return;
    const { categoryId } = state.deleteCatContext;
    $('#delete-cat-error').textContent = '';
    try {
      const res = await apiRequest(`./api/admin/categories/${categoryId}`, {
        method: 'DELETE',
        body: {},
      });
      closeDeleteCategoryDialog();
      notify(`カテゴリ「${res.deletedCategory.name}」を削除しました。`);
      await loadOverview();
    } catch (err) {
      $('#delete-cat-error').textContent = err.message;
    }
  }

  async function handleCreateThread(ev) {
    ev.preventDefault();
    showErrorBanner('');
    const categoryId = Number($('#new-thread-cat').value);
    const title = $('#new-thread-title').value;
    const pinnedTextRaw = $('#new-thread-pinned-text').value;
    const rawOrder = $('#new-thread-order').value.trim();
    const isPinned = $('#new-thread-is-pinned').checked;

    const body = {
      categoryId,
      title,
      pinnedText: pinnedTextRaw.trim() === '' ? null : pinnedTextRaw,
      isPinned,
    };
    if (rawOrder !== '') {
      body.displayOrder = Number(rawOrder);
    }

    try {
      const res = await apiRequest('./api/admin/threads', { method: 'POST', body });
      $('#new-thread-title').value = '';
      $('#new-thread-pinned-text').value = '';
      $('#new-thread-order').value = '';
      $('#new-thread-is-pinned').checked = false;
      notify(`スレッド「${res.thread.title}」を作成しました。`);
      await loadOverview();
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  async function handleUpdateThread(threadId, formValues) {
    showErrorBanner('');
    const body = {
      title: formValues.title,
      isPinned: Boolean(formValues.isPinned),
      pinnedText: formValues.pinnedText.trim() === '' ? null : formValues.pinnedText,
    };
    if (String(formValues.displayOrder).trim() !== '') {
      body.displayOrder = Number(formValues.displayOrder);
    }
    try {
      const res = await apiRequest(`./api/admin/threads/${threadId}`, {
        method: 'PATCH',
        body,
      });
      notify(`スレッド #${res.thread.id}「${res.thread.title}」を保存しました。`);
      await loadOverview();
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  async function openPurgeThreadDialog(threadId, triggerEl) {
    showErrorBanner('');
    try {
      const preview = await apiRequest(`./api/admin/threads/${threadId}/delete-preview`);
      state.purgeContext = {
        threadId,
        title: preview.thread.title,
        expectedPostCount: Number(preview.postsCount),
        triggerEl,
      };
      $('#purge-target-title').textContent = `#${preview.thread.id}「${preview.thread.title}」`;
      $('#purge-target-count').textContent = `${preview.postsCount} 件`;
      $('#purge-confirm-input').value = '';
      $('#purge-dialog-error').textContent = '';
      const dialog = $('#purge-thread-dialog');
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
        $('#purge-confirm-input').focus();
      }
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  function closePurgeThreadDialog() {
    const dialog = $('#purge-thread-dialog');
    if (dialog.open) dialog.close();
    const trigger = state.purgeContext?.triggerEl;
    state.purgeContext = null;
    if (trigger && typeof trigger.focus === 'function') {
      trigger.focus();
    }
  }

  async function handleConfirmPurgeThread(ev) {
    ev.preventDefault();
    if (!state.purgeContext) return;
    const confirmTitle = $('#purge-confirm-input').value;
    $('#purge-dialog-error').textContent = '';

    try {
      const res = await apiRequest(`./api/admin/threads/${state.purgeContext.threadId}`, {
        method: 'DELETE',
        body: {
          confirmTitle,
          expectedPostCount: state.purgeContext.expectedPostCount,
        },
      });
      closePurgeThreadDialog();
      notify(`スレッド「${res.deletedThread.title}」と投稿 ${res.deletedPostsCount} 件を削除しました。`);
      await loadOverview();
      if (state.activeTab === 'posts') {
        await loadModThreadPosts(state.selectedModThreadId);
      }
    } catch (err) {
      if (err.code === 'THREAD_POST_COUNT_CHANGED' && err.details && Number.isSafeInteger(err.details.actualPostsCount)) {
        state.purgeContext.expectedPostCount = err.details.actualPostsCount;
        $('#purge-target-count').textContent = `${err.details.actualPostsCount} 件（最新に更新済み）`;
      }
      $('#purge-dialog-error').textContent = err.message;
    }
  }

  async function handleTogglePostPin(postId, nextPinned) {
    showErrorBanner('');
    try {
      await apiRequest(`./api/admin/posts/${postId}/pin`, {
        method: 'POST',
        body: { pinned: nextPinned },
      });
      notify(nextPinned ? `投稿 #${postId} をピン留めしました。` : `投稿 #${postId} のピン留めを解除しました。`);
      await loadModThreadPosts(state.selectedModThreadId);
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  async function handleSoftDeletePost(postId) {
    showErrorBanner('');
    try {
      await apiRequest(`./api/admin/posts/${postId}/delete`, {
        method: 'POST',
        body: {},
      });
      notify(`投稿 #${postId} を非表示（論理削除）にしました。`);
      await loadModThreadPosts(state.selectedModThreadId);
    } catch (err) {
      showErrorBanner(err.message, true);
    }
  }

  // -------------------------------------------------------------------
  // 6. タブ切替・キーボード操作・初期化
  // -------------------------------------------------------------------
  function switchTab(nextTab) {
    state.activeTab = nextTab;
    const tabs = Array.from(document.querySelectorAll('.admin-tab[data-tab]'));
    for (const btn of tabs) {
      const selected = btn.dataset.tab === nextTab;
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('tabindex', selected ? '0' : '-1');
    }
    const panels = [
      ['structure', '#panel-structure'],
      ['posts', '#panel-posts'],
      ['users', '#panel-users'],
      ['audit', '#panel-audit'],
    ];
    for (const [key, selector] of panels) {
      const panel = $(selector);
      if (panel) panel.hidden = key !== nextTab;
    }
  }

  function bindTabs() {
    const tablist = document.querySelector('.admin-tabs');
    if (!tablist) return;
    const tabs = Array.from(tablist.querySelectorAll('.admin-tab[data-tab]'));

    async function activateTab(tabKey) {
      switchTab(tabKey);
      showErrorBanner('');
      try {
        if (tabKey === 'posts' && state.selectedModThreadId) {
          await loadModThreadPosts(state.selectedModThreadId);
        } else if (tabKey === 'users') {
          await loadUsers(state.usersOffset);
        } else if (tabKey === 'audit') {
          await loadAuditLogs(false);
        }
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    }

    tabs.forEach((btn, index) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
      btn.addEventListener('keydown', (ev) => {
        let nextIdx = -1;
        if (ev.key === 'ArrowRight') nextIdx = (index + 1) % tabs.length;
        else if (ev.key === 'ArrowLeft') nextIdx = (index - 1 + tabs.length) % tabs.length;
        else if (ev.key === 'Home') nextIdx = 0;
        else if (ev.key === 'End') nextIdx = tabs.length - 1;
        if (nextIdx >= 0) {
          ev.preventDefault();
          tabs[nextIdx].focus();
          activateTab(tabs[nextIdx].dataset.tab);
        }
      });
    });
  }

  function bindEvents() {
    bindTabs();

    $('#admin-reload-all').addEventListener('click', async () => {
      try {
        await refreshAllActiveData();
        notify('最新の管理データを再読込しました。');
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#create-category-form').addEventListener('submit', handleCreateCategory);
    $('#create-thread-form').addEventListener('submit', handleCreateThread);

    $('#mod-thread-select').addEventListener('change', async (ev) => {
      state.selectedModThreadId = ev.target.value ? Number(ev.target.value) : null;
      try {
        await loadModThreadPosts(state.selectedModThreadId);
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#mod-posts-reload').addEventListener('click', async () => {
      try {
        await loadModThreadPosts(state.selectedModThreadId);
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#users-prev-btn').addEventListener('click', async () => {
      try {
        await loadUsers(Math.max(0, state.usersOffset - USERS_PAGE_LIMIT));
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#users-next-btn').addEventListener('click', async () => {
      try {
        await loadUsers(state.usersOffset + USERS_PAGE_LIMIT);
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#audit-reload-btn').addEventListener('click', async () => {
      try {
        await loadAuditLogs(false);
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#audit-more-btn').addEventListener('click', async () => {
      try {
        await loadAuditLogs(true);
      } catch (err) {
        showErrorBanner(err.message, true);
      }
    });

    $('#purge-thread-form').addEventListener('submit', handleConfirmPurgeThread);
    $('#purge-cancel-btn').addEventListener('click', closePurgeThreadDialog);
    $('#purge-dialog-close').addEventListener('click', closePurgeThreadDialog);
    $('#purge-thread-dialog').addEventListener('cancel', (ev) => {
      ev.preventDefault();
      closePurgeThreadDialog();
    });

    $('#delete-category-form').addEventListener('submit', handleConfirmDeleteCategory);
    $('#delete-cat-cancel').addEventListener('click', closeDeleteCategoryDialog);
    $('#delete-cat-close').addEventListener('click', closeDeleteCategoryDialog);
    $('#delete-category-dialog').addEventListener('cancel', (ev) => {
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
      // showAuthGate は apiRequest の 401/403 処理で既に反映済み。通信断等の場合のみフォールバック。
      if ($('#admin-auth-gate').hidden === false && $('#admin-gate-message').textContent.includes('確認しています')) {
        showAuthGate('管理画面の読み込みに失敗しました。通信状況を確認して再度お試しください。');
      }
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
