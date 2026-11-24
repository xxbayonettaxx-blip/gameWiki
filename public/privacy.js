'use strict';

/**
 * =====================================================================
 * public/privacy.js
 * 役割：プライバシーポリシーページへ掲示板と同じ表示設定（テーマ・文字サイズ）を反映する
 * =====================================================================
 */

(() => {
  const PREF_KEY = 'community-board-prefs-v1';
  const ALLOWED_THEMES = ['light', 'dark', 'paper', 'ud-light', 'ud-dark'];
  const ALLOWED_FONTS = [14, 16, 18];

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
    // ストレージアクセス制限時は既定のライトテーマ・16pxで表示
  }
})();
