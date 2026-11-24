'use strict';

/**
 * =====================================================================
 * public/app.js
 * 役割：本番フロントエンド（読む体験優先・スライドドロワー＆上スライド設定版）
 * 主なUX・保守・セキュリティ方針：
 *   1. innerHTML は不使用（createElement + textContent でHTML解釈によるXSSを防止）。
 *   2. 普段は入力欄を隠し、「新規投稿」「返信」押下時のみスライド展開。
 *      （モバイル＝上から入力シート、PC＝右からサイドドロワー）
 *   3. F1対策：選択要求中のスレッドID（loadingThreadId）と表示確定済みID（activeThreadId）を分離。
 *      GET取得中や取得失敗時は誤送信を防止し、表示中のスレッドと投稿先が食い違わないようにする。
 *   4. F4対策：閉じたドロワー・設定シートに inert を付与し、開いた時は即座にフォーカスを移動、
 *      Tabキー循環・Esc解除・閉じた後の元のボタンへのフォーカス復帰・再描画後のフォーカス維持を行う。
 * ===================================================================== */

(() => {
  const PREF_KEY = 'community-board-prefs-v1';
  const ALLOWED_THEMES = ['light', 'dark', 'paper', 'ud-light', 'ud-dark'];
  const ALLOWED_FONTS = [14, 16, 18];
  const ALLOWED_SORTS = ['new', 'activity', 'old'];
  const AVATAR_COLORS = ['', 'sage', 'sand', 'blue'];
  const MAX_VISUAL_DEPTH = 2; // 親(0)・子(1)・孫(2)の3層までインデント、4層目以降はフラット
  const AUTH_MISMATCH_FORM_ERROR =
    'アカウント状態が変更されたため送信を中断しました（下書きは保持しています）。';

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
    drafts: new Map(),          // threadId -> { content, replyId }（このページを開いている間だけ保持）
    composerOpen: false,
    composerTriggerEl: null,
    composerTriggerSelector: null,
    settingsOpen: false,
    authOpen: false,
    authTab: 'login',
    postPasswordChangeNotice: false,
    authSeq: 0,
    bootstrapSeq: 0,
    isAuthSubmitting: false,
    user: null,                 // { id, username, role, mustChangePassword } | null
    anonAuthorDraft: '',
    pendingSessionExpired: false,
    pendingAuthChangedMessage: '',
    reopenComposerAfterAuth: false,
    isSubmitting: false,
    loadSeq: 0,
    abortCtrl: null,
    toastTimer: null,
    prefs: {
      theme: 'light',
      font: 16,
      background: true,
      sort: 'new',
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

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // 直近24時間以内の更新（投稿・返信またはスレッド新設）かどうかを判定
  function isRecent(isoString) {
    if (!isoString) return false;
    const time = new Date(isoString).getTime();
    if (Number.isNaN(time)) return false;
    const diff = Date.now() - time;
    return diff >= 0 && diff <= ONE_DAY_MS;
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
        if (ALLOWED_SORTS.includes(saved.sort)) state.prefs.sort = saved.sort;
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
    const sortSelect = $('#sort');
    if (sortSelect) sortSelect.value = state.prefs.sort;

    if (save) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));
      } catch {
        notify('表示を変更しました（このブラウザ設定では保存できません）。');
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. 上からスライド展開する「表示設定シート」＆ モーダル/非モーダル境界制御（R5）
  // -------------------------------------------------------------------
  const DESKTOP_MEDIA = window.matchMedia('(min-width: 760px)');
  const BACKGROUND_SELECTORS = ['.skip-link', 'header.masthead', '.site-shell', '#fab-write'];

  function syncOverlayAccessibility() {
    const isDesktop = DESKTOP_MEDIA.matches;
    const composerIsModal = state.composerOpen && !isDesktop;
    const hasModal = state.authOpen || state.settingsOpen || composerIsModal;

    const drawer = $('#composer-drawer');
    const composerBackdrop = $('#composer-backdrop');
    if (drawer) {
      drawer.setAttribute('aria-modal', String(composerIsModal));
      const drawerHidden = !state.composerOpen || state.authOpen || state.settingsOpen;
      drawer.inert = drawerHidden;
      drawer.setAttribute('aria-hidden', String(drawerHidden));
    }
    if (composerBackdrop) {
      composerBackdrop.hidden = !composerIsModal;
    }

    for (const sel of BACKGROUND_SELECTORS) {
      const node = $(sel);
      if (!node) continue;
      node.inert = hasModal;
      if (hasModal) {
        node.setAttribute('aria-hidden', 'true');
      } else {
        node.removeAttribute('aria-hidden');
      }
    }
  }

  function openSettings() {
    if (state.authOpen) {
      closeAuthSheet({ restoreFocus: false });
    }
    if (state.composerOpen && !DESKTOP_MEDIA.matches) {
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
    syncOverlayAccessibility();
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
    syncOverlayAccessibility();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function toggleSettings() {
    if (state.settingsOpen) closeSettings();
    else openSettings();
  }

  // -------------------------------------------------------------------
  // 3b. アカウント認証シート（ログイン / 新規登録 / パスワード変更 / ログアウト）
  // -------------------------------------------------------------------
  function countCodePoints(str) {
    return Array.from(String(str || '')).length;
  }

  function clearAuthPasswords() {
    for (const sel of [
      '#login-password',
      '#register-password',
      '#register-password-confirm',
      '#current-password',
      '#new-password',
      '#new-password-confirm',
    ]) {
      const input = $(sel);
      if (input) input.value = '';
    }
  }

  function clearAuthErrors() {
    for (const sel of ['#login-error', '#register-error', '#password-error', '#logout-error']) {
      const node = $(sel);
      if (node) node.textContent = '';
    }
  }

  function syncAuthUI() {
    const trigger = $('#auth-open');
    const triggerLabel = $('#auth-open-label');
    if (trigger && triggerLabel) {
      trigger.classList.toggle('is-logged-in', Boolean(state.user));
      trigger.classList.toggle('is-must-change', Boolean(state.user?.mustChangePassword));
      if (state.user) {
        triggerLabel.textContent = state.user.mustChangePassword
          ? `${state.user.username}(要変更)`
          : state.user.username;
        trigger.setAttribute('aria-label', `アカウントメニュー (${state.user.username})`);
        trigger.title = state.user.mustChangePassword
          ? `${state.user.username}（パスワード変更が必要）`
          : state.user.username;
      } else {
        triggerLabel.textContent = 'ログイン';
        trigger.setAttribute('aria-label', 'アカウント・ログインを開く');
        trigger.title = 'ログイン・新規登録';
      }
    }

    const guestPanel = $('#auth-guest-panel');
    const memberPanel = $('#auth-member-panel');
    const titleEl = $('#auth-sheet-title');
    const loginNotice = $('#login-notice');

    if (state.user) {
      const mustChange = Boolean(state.user.mustChangePassword);
      if (guestPanel) guestPanel.hidden = true;
      if (memberPanel) memberPanel.hidden = false;
      if (titleEl) {
        titleEl.textContent = mustChange
          ? 'パスワード変更のお願い'
          : 'アカウント管理';
      }
      $('#auth-member-name').textContent = state.user.username;
      $('#auth-member-role').textContent = state.user.role === 'admin' ? '管理者' : '一般会員';
      $('#must-change-banner').hidden = !mustChange;

      const pwSection = $('#password-section');
      if (pwSection) {
        pwSection.classList.toggle('is-required', mustChange);
        if (mustChange) pwSection.open = true;
      }
      const pwSummary = $('#password-section-summary');
      if (pwSummary) {
        pwSummary.textContent = mustChange
          ? '仮パスワードから新しいパスワードへ変更（必須）'
          : 'パスワードを変更する';
      }
      const curLabel = $('#current-password-label');
      if (curLabel) {
        curLabel.textContent = mustChange
          ? '現在のパスワード（管理者から受け取った仮パスワード）'
          : '現在のパスワード';
      }
      const curInput = $('#current-password');
      if (curInput) {
        curInput.placeholder = mustChange ? '管理者から受け取った仮パスワードを入力' : '';
      }
      const curHint = $('#current-password-hint');
      if (curHint) {
        curHint.hidden = !mustChange;
        curHint.textContent = mustChange
          ? '※先ほどログインに使った「仮パスワード」を入力してください（リセット前の旧パスワードではありません）。'
          : '';
      }
      const newLabel = $('#new-password-label');
      if (newLabel) {
        newLabel.textContent = mustChange
          ? '新しく設定する本番パスワード（8〜128文字）'
          : '新しいパスワード（8〜128文字）';
      }
      const pwSubmit = $('#password-submit');
      if (pwSubmit) {
        pwSubmit.textContent = mustChange
          ? '新しいパスワードを設定してログイン画面へ進む'
          : 'パスワードを変更する（変更後は再ログイン）';
      }
      if (loginNotice) {
        loginNotice.hidden = true;
        loginNotice.textContent = '';
      }
    } else {
      if (guestPanel) guestPanel.hidden = false;
      if (memberPanel) memberPanel.hidden = true;
      if (titleEl) titleEl.textContent = 'ログイン・新規登録';

      const isLogin = state.authTab !== 'register';
      const loginTab = $('#auth-tab-login');
      const registerTab = $('#auth-tab-register');
      if (loginTab) {
        loginTab.setAttribute('aria-selected', String(isLogin));
        loginTab.tabIndex = isLogin ? 0 : -1;
      }
      if (registerTab) {
        registerTab.setAttribute('aria-selected', String(!isLogin));
        registerTab.tabIndex = isLogin ? -1 : 0;
      }
      $('#login-form').hidden = !isLogin;
      $('#register-form').hidden = isLogin;
      if (loginNotice) {
        const showChanged = state.postPasswordChangeNotice && isLogin;
        loginNotice.hidden = !showChanged;
        loginNotice.textContent = showChanged
          ? '✓ パスワードを変更しました。安全のため全端末からログアウトしています。引き継がれたユーザー名のまま、新しく設定したパスワードで再ログインしてください。'
          : '';
      }
    }

    const authorInput = $('#author-name');
    const authNote = $('#composer-auth-note');
    const mustChangeBox = $('#composer-must-change-box');
    const expiredBox = $('#session-expired-box');
    const authChangedBox = $('#auth-changed-box');
    const authChangedMessage = $('#auth-changed-message');

    if (authorInput) {
      if (state.user) {
        if (!authorInput.readOnly) {
          state.anonAuthorDraft = authorInput.value;
        }
        authorInput.value = state.user.username;
        authorInput.readOnly = true;
        if (authNote) {
          authNote.hidden = false;
          authNote.textContent = `会員アカウント「${state.user.username}」として投稿されます（投稿者名は固定）。`;
        }
        if (mustChangeBox) mustChangeBox.hidden = !state.user.mustChangePassword;
        state.pendingSessionExpired = false;
        if (expiredBox) expiredBox.hidden = true;
      } else {
        if (authorInput.readOnly) {
          authorInput.value = state.anonAuthorDraft || '';
        }
        authorInput.readOnly = false;
        if (authNote) {
          authNote.hidden = true;
          authNote.textContent = '';
        }
        if (mustChangeBox) mustChangeBox.hidden = true;
        state.pendingAuthChangedMessage = '';
        if (expiredBox) expiredBox.hidden = !state.pendingSessionExpired;
      }
    }

    const showAuthChanged = Boolean(state.user && state.pendingAuthChangedMessage);
    if (authChangedBox) authChangedBox.hidden = !showAuthChanged;
    if (authChangedMessage) {
      authChangedMessage.textContent = showAuthChanged ? state.pendingAuthChangedMessage : '';
    }

    syncSubmitAvailability();
  }

  function focusFirstAuthField() {
    if (state.user) {
      if (state.user.mustChangePassword) {
        $('#current-password')?.focus({ preventScroll: true });
      } else {
        // 通常会員はパスワード欄を折りたたんで表示するため閉じるボタンへ安全にフォーカスする
        $('#auth-close')?.focus({ preventScroll: true });
      }
    } else if (state.authTab === 'register') {
      $('#register-username')?.focus({ preventScroll: true });
    } else if (state.postPasswordChangeNotice && $('#login-username')?.value.trim()) {
      $('#login-password')?.focus({ preventScroll: true });
    } else {
      $('#login-username')?.focus({ preventScroll: true });
    }
  }

  function selectAuthTab(tabName, { focusTab = false, focusInput = false } = {}) {
    state.authTab = tabName === 'register' ? 'register' : 'login';
    state.postPasswordChangeNotice = false;
    clearAuthPasswords();
    clearAuthErrors();
    syncAuthUI();
    if (focusTab) {
      const targetTab = state.authTab === 'register' ? $('#auth-tab-register') : $('#auth-tab-login');
      targetTab?.focus({ preventScroll: true });
    } else if (focusInput) {
      const targetInput = state.authTab === 'register' ? $('#register-username') : $('#login-username');
      targetInput?.focus({ preventScroll: true });
    }
  }

  function openAuthSheet({ tab = null, reopenComposer = false } = {}) {
    if (state.settingsOpen) {
      closeSettings({ restoreFocus: false });
    }
    if (state.composerOpen && !DESKTOP_MEDIA.matches) {
      closeComposer({ restoreFocus: false });
    }
    state.reopenComposerAfterAuth = Boolean(reopenComposer);
    if (tab === 'login' || tab === 'register') {
      state.authTab = tab;
    }
    state.authOpen = true;
    clearAuthErrors();
    const pwSection = $('#password-section');
    if (pwSection) pwSection.open = Boolean(state.user?.mustChangePassword);
    syncAuthUI();

    const sheet = $('#auth-sheet');
    const backdrop = $('#auth-backdrop');
    const trigger = $('#auth-open');
    backdrop.hidden = false;
    sheet.inert = false;
    sheet.setAttribute('aria-hidden', 'false');
    sheet.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    syncOverlayAccessibility();
    void sheet.offsetWidth;
    focusFirstAuthField();
  }

  function closeAuthSheet({ restoreFocus = true } = {}) {
    state.postPasswordChangeNotice = false;
    clearAuthPasswords();
    clearAuthErrors();
    if (!state.authOpen) return;
    state.authOpen = false;
    state.reopenComposerAfterAuth = false;

    const sheet = $('#auth-sheet');
    const backdrop = $('#auth-backdrop');
    const trigger = $('#auth-open');
    sheet.classList.remove('is-open');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.inert = true;
    backdrop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    syncOverlayAccessibility();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function toggleAuthSheet() {
    if (state.authOpen) closeAuthSheet();
    else openAuthSheet();
  }

  function commitAuthUser(nextUser) {
    state.authSeq += 1;
    state.user = nextUser || null;
  }

  async function probeCurrentUser() {
    try {
      const res = await fetch('api/auth/me', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res.ok) return { ok: false, user: null };
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object' || !('user' in data)) {
        return { ok: false, user: null };
      }
      return { ok: true, user: data.user || null };
    } catch {
      return { ok: false, user: null };
    }
  }

  async function fetchCurrentUser() {
    const reqAuthSeq = state.authSeq;
    const probed = await probeCurrentUser();
    if (!probed.ok) return null;
    if (reqAuthSeq !== state.authSeq) return state.user;
    commitAuthUser(probed.user);
    syncAuthUI();
    return state.user;
  }

  // -------------------------------------------------------------------
  // 4. スライド式投稿ドロワーの開閉 ＆ 送信可否・返信ハイライト制御
  // -------------------------------------------------------------------
  function canSubmitPost() {
    return (
      state.activeThreadId !== null &&
      state.loadingThreadId === null &&
      state.failedTargetThread === null &&
      !state.user?.mustChangePassword &&
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

  // スレッドを確定切替する直前に保存し、通信失敗時は表示中の下書きを維持する。
  function saveCurrentDraft() {
    if (state.activeThreadId === null) return;
    const content = $('#comment-body').value;
    if (content !== '' || state.replyTarget) {
      state.drafts.set(state.activeThreadId, {
        content,
        replyId: state.replyTarget?.id ?? null,
      });
    } else {
      state.drafts.delete(state.activeThreadId);
    }
  }

  function restoreThreadDraft() {
    const draft = state.drafts.get(state.activeThreadId);
    $('#comment-body').value = draft?.content ?? '';
    const reply = state.posts.find((post) => post.id === draft?.replyId && post.is_deleted !== 1);
    state.replyTarget = reply
      ? { id: reply.id, name: reply.author_name, content: reply.content }
      : null;
    if (draft?.replyId !== null && draft?.replyId !== undefined && !reply) {
      $('#form-error').textContent =
        '下書きの返信先が見つからないため、新規投稿に切り替えました。送信前に内容を確認してください。';
    }
    const length = $('#comment-body').value.length;
    $('#character-count').textContent = `${length.toLocaleString('ja-JP')} / 2,000`;
  }

  function openComposer(replyPost = null, triggerEl = null) {
    if (state.activeThreadId === null) {
      notify('スレッドが選択されていないため投稿できません。');
      return;
    }

    if (state.settingsOpen) {
      closeSettings({ restoreFocus: false });
    }
    if (state.authOpen) {
      closeAuthSheet({ restoreFocus: false });
    }

    rememberTrigger(triggerEl);
    // 入力済みの下書きを開き直すときは返信先も維持し、新規への変更は専用ボタンで行う。
    if (replyPost) {
      state.replyTarget = { id: replyPost.id, name: replyPost.author_name, content: replyPost.content };
    } else if ($('#comment-body').value === '') {
      state.replyTarget = null;
    }
    state.composerOpen = true;

    if (state.failedTargetThread) {
      $('#form-error').textContent =
        `「${state.failedTargetThread.title}」の取得に失敗しているため書き込めません。「↻ 更新」で再取得するか、スレッドを選び直してください。`;
    } else {
      $('#form-error').textContent = '';
    }
    syncComposerHeader();

    const drawer = $('#composer-drawer');
    drawer.classList.add('is-open');
    document.body.classList.add('composer-open');
    syncOverlayAccessibility();

    if (replyPost) {
      const postEl = document.getElementById(`post-${replyPost.id}`);
      if (postEl) {
        postEl.scrollIntoView({
          behavior: scrollBehavior(),
          block: !DESKTOP_MEDIA.matches ? 'end' : 'center',
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
    drawer.classList.remove('is-open');
    document.body.classList.remove('composer-open');
    syncOverlayAccessibility();
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

        const hasNew = (cat.threads || []).some((t) => isRecent(t.latest_post_at));
        const countText = String(cat.threads?.length || 0).padStart(2, '0');
        const catRight = el('span', 'category-right');
        if (hasNew) {
          const dot = el('span', 'new-dot', '●');
          dot.setAttribute('aria-label', '新着あり');
          dot.setAttribute('title', '24時間以内に更新あり');
          catRight.append(dot);
        }
        catRight.append(el('span', 'cat-count', countText));

        btn.append(
          icon(pickCategoryIcon(cat.name)),
          el('span', '', cat.name),
          catRight
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

        const isNew = isRecent(thread.latest_post_at);
        if (isNew) {
          const badge = el('span', 'new-badge', 'NEW');
          badge.setAttribute('aria-label', '24時間以内に更新');
          btn.append(badge);
        }

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
      meta.append(postNumEl, el('span', 'comment-author', node.author_name));
      if (node.is_member) {
        meta.append(el('span', 'member-badge', '会員'));
      }
      meta.append(el('span', 'comment-id', `ID: ${node.visitor_id}`));
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

  function getPostTimeMs(iso) {
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
  }

  // 未削除ノードのうち最新活動日時（同値は投稿ID降順）を返し、全削除ツリーのみ親投稿でフォールバックする
  function getTreeLatestActivity(root) {
    let bestMs = -Infinity;
    let bestId = -Infinity;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node.is_deleted !== 1) {
        const ms = getPostTimeMs(node.created_at);
        if (ms > bestMs || (ms === bestMs && node.id > bestId)) {
          bestMs = ms;
          bestId = node.id;
        }
      }
      for (const child of node.replies) {
        stack.push(child);
      }
    }
    if (bestMs === -Infinity) {
      return { ms: getPostTimeMs(root.created_at), id: root.id };
    }
    return { ms: bestMs, id: bestId };
  }

  function renderAllPosts() {
    if (state.activeThreadId === null) {
      $('#pinned-section').hidden = true;
      $('#comment-count').textContent = '0';
      $('#comments').replaceChildren(
        el('p', 'empty-message', 'このカテゴリにはまだスレッドが登録されていません。管理コマンド等でスレッドを作成してください。')
      );
      syncReplyingTargetHighlight();
      return;
    }

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

    const sortMode = ALLOWED_SORTS.includes(state.prefs.sort) ? state.prefs.sort : 'new';
    if (sortMode === 'new') {
      normalRoots.sort((a, b) => b.id - a.id);
    } else if (sortMode === 'activity') {
      const activityMap = new Map(normalRoots.map((r) => [r.id, getTreeLatestActivity(r)]));
      normalRoots.sort((a, b) => {
        const aAct = activityMap.get(a.id);
        const bAct = activityMap.get(b.id);
        if (bAct.ms !== aAct.ms) return bAct.ms - aAct.ms;
        if (bAct.id !== aAct.id) return bAct.id - aAct.id;
        return b.id - a.id;
      });
    } else {
      normalRoots.sort((a, b) => a.id - b.id);
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

  function syncThreadSummaryFromPosts(category, threadData, posts) {
    if (!category || !threadData) return;
    const tSummary = (category.threads || []).find((t) => t.id === threadData.id);
    if (!tSummary) return;
    tSummary.post_count = posts.length;
    // 最新の未削除投稿日時（0件時はスレッド作成日時）を同期し、投稿直後や更新時にNEW表示を即時反映する
    let latestAt = threadData.created_at || tSummary.latest_post_at || null;
    let latestMs = latestAt ? Date.parse(latestAt) : NaN;
    for (const p of posts) {
      if (p.is_deleted || !p.created_at) continue;
      const ms = Date.parse(p.created_at);
      if (!Number.isNaN(ms) && (Number.isNaN(latestMs) || ms > latestMs)) {
        latestMs = ms;
        latestAt = p.created_at;
      }
    }
    if (latestAt) tSummary.latest_post_at = latestAt;
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
    } else if (state.loadingThreadId === null) {
      $('#thread-title').textContent = 'スレッドがありません';
      $('#thread-label').textContent = 'THREAD --';
    }
    syncComposerHeader();
  }

  // -------------------------------------------------------------------
  // 7. API通信：まとめ取得(/api/bootstrap) ＆ スレッド詳細取得（F1対応）
  // -------------------------------------------------------------------
  function getThreadIdFromHash() {
    const hash = window.location.hash || '';
    const match = hash.match(/^#thread-(\d+)$/i) || hash.match(/^#th-(\d+)$/i);
    return match ? Number(match[1]) : null;
  }

  async function loadInitialData() {
    const reqBootSeq = ++state.bootstrapSeq;
    const reqAuthSeq = state.authSeq;
    showErrorBanner('');
    const loadingStatusEl = $('#initial-loading-status');
    let loadingTimer = null;
    if (loadingStatusEl) {
      loadingStatusEl.hidden = true;
      // 180ms以上の通信待ちが発生した場合のみ読み込み表示を出し、通常速度時のチラつきを抑える
      loadingTimer = setTimeout(() => {
        loadingStatusEl.hidden = false;
      }, 180);
    }

    try {
      const hashThreadId = getThreadIdFromHash();
      const bootstrapUrl =
        hashThreadId && Number.isSafeInteger(hashThreadId) && hashThreadId >= 1
          ? `api/bootstrap?threadId=${encodeURIComponent(String(hashThreadId))}`
          : 'api/bootstrap';

      const res = await fetch(bootstrapUrl, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (reqBootSeq !== state.bootstrapSeq) return;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // R1対策：要求開始後に認証操作（登録・ログイン・ログアウト・PW変更等）が確定していれば古い応答の user を破棄する
      if (reqAuthSeq === state.authSeq) {
        state.user = data.user || null;
        syncAuthUI();
      }

      state.categories = Array.isArray(data.categories) ? data.categories : [];
      if (state.categories.length === 0) {
        state.activeCategory = null;
        state.activeThreadId = null;
        state.activeThreadData = null;
        state.posts = [];
        $('#breadcrumb-category').textContent = '掲示板';
        $('#category-title').textContent = 'カテゴリがありません';
        $('#thread-title').textContent = 'スレッドがありません';
        $('#thread-label').textContent = 'THREAD --';
        renderNavigation();
        renderAllPosts();
        syncSubmitAvailability();
        return;
      }

      const initialThreadDetail = data.initialThread || null;
      if (initialThreadDetail && initialThreadDetail.thread) {
        const confirmedMeta = findThreadMeta(initialThreadDetail.thread.id);
        state.activeCategory = confirmedMeta ? confirmedMeta.category : state.categories[0];
        state.activeThreadId = initialThreadDetail.thread.id;
        state.activeThreadData = initialThreadDetail.thread;
        state.loadingThreadId = null;
        state.failedTargetThread = null;
        state.posts = Array.isArray(initialThreadDetail.posts) ? initialThreadDetail.posts : [];

        syncThreadSummaryFromPosts(
          state.activeCategory,
          state.activeThreadData,
          state.posts
        );

        const threadHash = `#thread-${state.activeThreadId}`;
        if (window.location.hash !== threadHash) {
          history.replaceState(null, '', threadHash);
        }
      } else {
        state.activeCategory = state.categories[0];
        state.activeThreadId = null;
        state.activeThreadData = null;
        state.loadingThreadId = null;
        state.failedTargetThread = null;
        state.posts = [];
      }

      renderNavigation();
      syncHeaders();
      renderAllPosts();
    } catch (err) {
      if (reqBootSeq !== state.bootstrapSeq) return;
      $('#breadcrumb-category').textContent = '通信エラー';
      $('#category-title').textContent = '掲示板を読み込めませんでした';
      $('#thread-category-tag').textContent = '-';
      $('#thread-label').textContent = 'THREAD --';
      $('#thread-title').textContent = '再読み込みをお試しください';
      showErrorBanner(err.message || 'サーバーとの通信に失敗しました。');
      syncSubmitAvailability();
    } finally {
      clearTimeout(loadingTimer);
      if (reqBootSeq === state.bootstrapSeq && loadingStatusEl) {
        loadingStatusEl.hidden = true;
      }
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

      const switchedThread = previousThreadId !== null && previousThreadId !== data.thread.id;
      if (switchedThread) saveCurrentDraft();

      // GET成功時点で初めて表示確定スレッド（activeCategory / activeThreadId / activeThreadData）を更新する
      const confirmedMeta = findThreadMeta(data.thread.id);
      if (confirmedMeta) {
        state.activeCategory = confirmedMeta.category;
      }
      state.activeThreadId = data.thread.id;
      state.activeThreadData = data.thread;
      state.loadingThreadId = null;
      state.failedTargetThread = null;
      state.posts = Array.isArray(data.posts) ? data.posts : [];

      if (switchedThread) {
        restoreThreadDraft();
        if (!DESKTOP_MEDIA.matches) {
          closeComposer({ restoreFocus: false });
        }
      }

      if (state.activeCategory) {
        syncThreadSummaryFromPosts(state.activeCategory, data.thread, state.posts);
      }

      renderNavigation();
      syncHeaders();
      renderAllPosts();

      // URLハッシュを #thread-<id> に同期（リロードや共有リンクで同一スレッドを復元できるようにする）
      const threadHash = `#thread-${data.thread.id}`;
      if (window.location.hash !== threadHash) {
        history.replaceState(null, '', threadHash);
      }

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
      if (state.user?.mustChangePassword) {
        openAuthSheet();
      } else if (state.loadingThreadId !== null) {
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

    // 送信開始時点のスレッドID・返信先ID・名前・本文・認証意図をローカル定数に固定する
    const submitThreadId = state.activeThreadId;
    const submitReplyId = state.replyTarget ? state.replyTarget.id : null;
    const submitAuthor = $('#author-name').value;
    const submitContent = rawContent;
    const submitExpectAuth = Boolean(state.user);
    const submitExpectedUserId = state.user ? state.user.id : null;

    state.isSubmitting = true;
    syncSubmitAvailability();
    $('#form-error').textContent = '';

    const reqAuthSeq = state.authSeq;
    try {
      const res = await fetch('api/posts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          thread_id: submitThreadId,
          parent_id: submitReplyId,
          author_name: submitAuthor,
          content: submitContent,
          expect_auth: submitExpectAuth,
          expected_user_id: submitExpectedUserId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
        if (reqAuthSeq === state.authSeq) {
          commitAuthUser(null);
          state.pendingSessionExpired = true;
          state.pendingAuthChangedMessage = '';
          syncAuthUI();
        }
        $('#form-error').textContent = data.error || 'ログインの有効期限が切れています。';
        $('#expired-relogin-btn')?.focus({ preventScroll: true });
        return;
      }
      if (res.status === 409 && data.code === 'AUTH_USER_MISMATCH') {
        const mismatchMsg =
          data.error ||
          '別タブ等でログイン状態が切り替わっています。下書きは保持しているため、現在のアカウントを確認してから再度操作してください。';
        if (reqAuthSeq === state.authSeq) {
          if (data.currentUser && typeof data.currentUser === 'object') {
            commitAuthUser(data.currentUser);
          } else {
            await fetchCurrentUser();
          }
          state.pendingSessionExpired = false;
          state.pendingAuthChangedMessage = mismatchMsg;
          syncAuthUI();
        }
        $('#form-error').textContent = AUTH_MISMATCH_FORM_ERROR;
        $('#auth-changed-open-account-btn')?.focus({ preventScroll: true });
        return;
      }
      if (res.status === 403 && data.code === 'PASSWORD_CHANGE_REQUIRED') {
        state.pendingAuthChangedMessage = '';
        await fetchCurrentUser();
        $('#form-error').textContent = data.error || '仮パスワードのままでは投稿できません。';
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || `投稿に失敗しました (HTTP ${res.status})`);
      }

      state.pendingSessionExpired = false;
      state.pendingAuthChangedMessage = '';
      syncAuthUI();

      // 成功した送信先の下書きだけを消し、別スレッドや別の返信先での編集を保持する。
      const submittedDraft = state.drafts.get(submitThreadId);
      if (submittedDraft?.content === submitContent && submittedDraft.replyId === submitReplyId) {
        state.drafts.delete(submitThreadId);
      }
      if (
        state.activeThreadId === submitThreadId &&
        (state.replyTarget?.id ?? null) === submitReplyId &&
        $('#comment-body').value === submitContent
      ) {
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
      } else {
        // スレッドが0件のカテゴリが選択された場合
        state.activeCategory = found;
        state.activeThreadId = null;
        state.activeThreadData = null;
        state.posts = [];
        state.loadingThreadId = null;
        state.failedTargetThread = null;
        if (state.composerOpen) {
          closeComposer({ restoreFocus: false });
        }
        renderNavigation();
        syncHeaders();
        renderAllPosts();
        syncSubmitAvailability();
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

    // ブラウザの「戻る / 進む」履歴やハッシュ変更に対応
    window.addEventListener('hashchange', () => {
      const targetId = getThreadIdFromHash();
      if (targetId && targetId !== state.activeThreadId && state.loadingThreadId === null) {
        loadThread(targetId);
      }
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

    // 「↻ 更新」は直近で失敗したスレッド・表示中スレッドを再取得（初回読込失敗時はbootstrap再実行）
    $('#reload-thread').addEventListener('click', () => {
      const targetId = state.failedTargetThread ? state.failedTargetThread.id : state.activeThreadId;
      if (targetId !== null) {
        loadThread(targetId, { preserveFocusSelector: '#reload-thread' });
      } else {
        loadInitialData();
      }
    });
    $('#sort').addEventListener('change', (e) => {
      const nextSort = ALLOWED_SORTS.includes(e.target.value) ? e.target.value : 'new';
      state.prefs.sort = nextSort;
      applyPreferences(true);
      renderAllPosts();
    });

    $('#comment-body').addEventListener('input', () => {
      const len = $('#comment-body').value.length;
      $('#character-count').textContent = `${len.toLocaleString('ja-JP')} / 2,000`;
      if (!state.failedTargetThread) {
        $('#form-error').textContent = '';
      }
    });

    $('#comment-form').addEventListener('submit', handleSubmit);

    function clearPendingComposerAuthAlerts() {
      const formErrorEl = $('#form-error');
      if (
        formErrorEl &&
        state.pendingAuthChangedMessage &&
        (formErrorEl.textContent === state.pendingAuthChangedMessage ||
          formErrorEl.textContent === AUTH_MISMATCH_FORM_ERROR)
      ) {
        formErrorEl.textContent = '';
      }
      state.pendingSessionExpired = false;
      state.pendingAuthChangedMessage = '';
    }

    // 仮パスワード制限 / セッション期限切れ / アカウント切替時の案内アクション
    $('#composer-open-password-btn').addEventListener('click', () => openAuthSheet());
    $('#expired-relogin-btn').addEventListener('click', () => {
      openAuthSheet({ tab: 'login', reopenComposer: true });
    });
    $('#expired-anon-btn').addEventListener('click', () => {
      commitAuthUser(null);
      clearPendingComposerAuthAlerts();
      syncAuthUI();
      $('#comment-form').requestSubmit();
    });
    $('#auth-changed-open-account-btn').addEventListener('click', () => {
      openAuthSheet({ reopenComposer: true });
    });

    // アカウント認証シート（開閉・タブ切替・登録・ログイン・パスワード変更・ログアウト）
    $('#auth-open').addEventListener('click', toggleAuthSheet);
    $('#auth-close').addEventListener('click', () => closeAuthSheet());
    $('#auth-backdrop').addEventListener('click', () => closeAuthSheet());

    $('#auth-tab-login').addEventListener('click', () => {
      selectAuthTab('login', { focusInput: true });
    });
    $('#auth-tab-register').addEventListener('click', () => {
      selectAuthTab('register', { focusInput: true });
    });
    // R4：WAI-ARIA Tabs 仕様準拠（左右矢印・Home・End でタブ間移動＋選択同期）
    $('.auth-tabs')?.addEventListener('keydown', (e) => {
      if (state.user) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const nextTab = state.authTab === 'register' ? 'login' : 'register';
        selectAuthTab(nextTab, { focusTab: true });
      } else if (e.key === 'Home') {
        e.preventDefault();
        selectAuthTab('login', { focusTab: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        selectAuthTab('register', { focusTab: true });
      }
    });
    DESKTOP_MEDIA.addEventListener('change', syncOverlayAccessibility);

    $('#password-section-summary')?.addEventListener('click', (e) => {
      if (state.user?.mustChangePassword) e.preventDefault();
    });
    $('#password-section')?.addEventListener('toggle', (e) => {
      if (state.user?.mustChangePassword && !e.currentTarget.open) {
        e.currentTarget.open = true;
      }
    });

    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.isAuthSubmitting) return;
      clearAuthErrors();
      const username = $('#login-username').value;
      const password = $('#login-password').value;

      state.isAuthSubmitting = true;
      $('#login-submit').disabled = true;
      try {
        const res = await fetch('api/auth/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          $('#login-error').textContent = data.error || `ログインに失敗しました (HTTP ${res.status})`;
          return;
        }
        clearAuthPasswords();
        commitAuthUser(data.user);
        clearPendingComposerAuthAlerts();
        state.postPasswordChangeNotice = false;
        const shouldReopen = state.reopenComposerAfterAuth && !state.user?.mustChangePassword;
        syncAuthUI();

        if (state.user?.mustChangePassword) {
          notify('仮パスワードでログインしました。新しいパスワードへ変更してください。');
          $('#current-password').focus({ preventScroll: true });
        } else if (shouldReopen) {
          closeAuthSheet({ restoreFocus: false });
          openComposer(null, $('#write-comment'));
          notify(`${state.user.username} として再ログインしました。投稿を続けられます。`);
        } else {
          closeAuthSheet();
          notify(`${state.user.username} としてログインしました。`);
        }
      } catch {
        $('#login-error').textContent = '通信エラーが発生しました。時間をおいて再試行してください。';
      } finally {
        state.isAuthSubmitting = false;
        $('#login-submit').disabled = false;
      }
    });

    $('#register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.isAuthSubmitting) return;
      clearAuthErrors();
      const username = $('#register-username').value;
      const password = $('#register-password').value;
      const passwordConfirm = $('#register-password-confirm').value;

      const trimmedNameLen = countCodePoints(
        username.replace(/^[\s\u3000\u200B-\u200D\u2060\uFEFF]+|[\s\u3000\u200B-\u200D\u2060\uFEFF]+$/g, '')
      );
      if (trimmedNameLen < 3 || trimmedNameLen > 30) {
        $('#register-error').textContent = 'ユーザー名は3〜30文字で入力してください。';
        $('#register-username').focus();
        return;
      }
      const passwordLen = countCodePoints(password);
      if (passwordLen < 8 || passwordLen > 128) {
        $('#register-error').textContent = 'パスワードは8〜128文字で入力してください。';
        $('#register-password').focus();
        return;
      }
      if (password !== passwordConfirm) {
        $('#register-error').textContent = 'パスワードと確認用パスワードが一致しません。';
        $('#register-password-confirm').focus();
        return;
      }

      state.isAuthSubmitting = true;
      $('#register-submit').disabled = true;
      try {
        const res = await fetch('api/auth/register', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          $('#register-error').textContent = data.error || `登録に失敗しました (HTTP ${res.status})`;
          return;
        }
        clearAuthPasswords();
        commitAuthUser(data.user);
        clearPendingComposerAuthAlerts();
        state.postPasswordChangeNotice = false;
        const shouldReopen = state.reopenComposerAfterAuth && !state.user?.mustChangePassword;
        syncAuthUI();
        if (shouldReopen) {
          closeAuthSheet({ restoreFocus: false });
          openComposer(null, $('#write-comment'));
          notify(`アカウント「${state.user.username}」を作成しログインしました。投稿を続けられます。`);
        } else {
          closeAuthSheet();
          notify(`アカウント「${state.user.username}」を作成しログインしました。`);
        }
      } catch {
        $('#register-error').textContent = '通信エラーが発生しました。時間をおいて再試行してください。';
      } finally {
        state.isAuthSubmitting = false;
        $('#register-submit').disabled = false;
      }
    });

    $('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (state.isAuthSubmitting) return;
      clearAuthErrors();
      const currentPassword = $('#current-password').value;
      const newPassword = $('#new-password').value;
      const newPasswordConfirm = $('#new-password-confirm').value;

      const newPasswordLen = countCodePoints(newPassword);
      if (newPasswordLen < 8 || newPasswordLen > 128) {
        $('#password-error').textContent = '新しいパスワードは8〜128文字で入力してください。';
        $('#new-password').focus();
        return;
      }
      if (newPassword !== newPasswordConfirm) {
        $('#password-error').textContent = '新しいパスワードと確認用パスワードが一致しません。';
        $('#new-password-confirm').focus();
        return;
      }

      state.isAuthSubmitting = true;
      $('#password-submit').disabled = true;
      try {
        const res = await fetch('api/auth/password', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401 && !String(data.error || '').includes('現在のパスワード')) {
            await fetchCurrentUser();
          }
          $('#password-error').textContent = data.error || `変更に失敗しました (HTTP ${res.status})`;
          return;
        }
        const changedUsername = state.user?.username || '';
        clearAuthPasswords();
        commitAuthUser(null);
        state.authTab = 'login';
        clearPendingComposerAuthAlerts();
        state.postPasswordChangeNotice = true;
        syncAuthUI();
        if (changedUsername && $('#login-username')) {
          $('#login-username').value = changedUsername;
        }
        if (changedUsername && $('#login-password')) {
          $('#login-password').focus({ preventScroll: true });
        } else {
          $('#login-username')?.focus({ preventScroll: true });
        }
        notify('パスワードを変更しました。新しいパスワードで再ログインしてください。');
      } catch {
        $('#password-error').textContent = '通信エラーが発生しました。時間をおいて再試行してください。';
      } finally {
        state.isAuthSubmitting = false;
        $('#password-submit').disabled = false;
      }
    });

    $('#logout-button').addEventListener('click', async () => {
      if (state.isAuthSubmitting) return;
      clearAuthPasswords();
      clearAuthErrors();
      state.isAuthSubmitting = true;
      $('#logout-button').disabled = true;

      let serverErr = '';
      let logoutSucceeded = false;
      try {
        const res = await fetch('api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          logoutSucceeded = true;
        } else {
          serverErr = data?.error || '';
        }
      } catch {
        // 応答喪失または通信切断時は下の再照会でサーバー上の実状態を確認する
      }

      try {
        const finishLoggedOut = (noticeText) => {
          commitAuthUser(null);
          state.authTab = 'login';
          clearPendingComposerAuthAlerts();
          state.postPasswordChangeNotice = false;
          const shouldReopen = state.reopenComposerAfterAuth;
          syncAuthUI();
          if (shouldReopen) {
            closeAuthSheet({ restoreFocus: false });
            openComposer(null, $('#write-comment'));
          } else {
            closeAuthSheet();
          }
          notify(noticeText);
        };

        if (logoutSucceeded) {
          finishLoggedOut('ログアウトしました。');
          return;
        }

        const probed = await probeCurrentUser();
        if (probed.ok && probed.user === null) {
          finishLoggedOut('ログアウトを確認しました。');
          return;
        }

        if (probed.ok && probed.user !== null) {
          commitAuthUser(probed.user);
          syncAuthUI();
          $('#logout-error').textContent =
            serverErr || 'ログアウトを完了できませんでした。時間をおいて再度お試しください。';
          notify('ログアウトに失敗しました。ログイン状態が残っています。');
          return;
        }

        $('#logout-error').textContent =
          '通信エラーによりログアウトを完了できませんでした。通信回復後に再度お試しください。';
        notify('ログアウトを完了できませんでした。再試行してください。');
      } finally {
        state.isAuthSubmitting = false;
        $('#logout-button').disabled = false;
      }
    });

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
        if (state.authOpen) {
          e.preventDefault();
          closeAuthSheet();
        } else if (state.settingsOpen) {
          e.preventDefault();
          closeSettings();
        } else if (state.composerOpen) {
          e.preventDefault();
          closeComposer();
        }
        return;
      }

      if (e.key === 'Tab') {
        // R5：PC時の投稿ドロワーは非モーダルのためTab循環せず背景へ移動可能にする
        const activePanel = state.authOpen
          ? $('#auth-sheet')
          : state.settingsOpen
            ? $('#settings-sheet')
            : state.composerOpen && !DESKTOP_MEDIA.matches
              ? $('#composer-drawer')
              : null;
        if (!activePanel) return;

        const focusables = [
          ...activePanel.querySelectorAll(
            'summary, a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ),
        ].filter((node) => {
          if (node.closest('[hidden]')) return false;
          const closedDetails = node.closest('details:not([open])');
          if (closedDetails && node.closest('summary')?.parentElement !== closedDetails) {
            return false;
          }
          return true;
        });

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
