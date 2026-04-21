/**
 * Praxmate Widget Loader
 * https://praxmate.de/widget.js
 *
 * Usage:
 *   <script src="https://praxmate.pages.dev/widget.js"
 *           data-practice="hild"
 *           data-mode="floating"
 *           data-color="#0ea5e9"
 *           data-label="Termin online buchen"></script>
 *
 * Modes:
 *   floating  → fixed bottom-right button, opens modal on click
 *   inline    → renders directly inside <div data-praxmate-widget>
 *   popup     → any element with [data-praxmate-trigger] opens modal
 *
 * Data attributes (all optional except practice):
 *   data-practice  Practice slug (REQUIRED)
 *   data-mode      'floating' | 'inline' | 'popup'  (default: floating)
 *   data-color     Hex color for button (default: #0ea5e9)
 *   data-label     Button text (default: 'Termin online buchen')
 *   data-source    'minimal' or empty (minimal hides branding footer + meta)
 *   data-host      API host override (default: praxmate.pages.dev)
 */

(function () {
  'use strict';

  // --- Locate this script tag ---
  const scriptTag = document.currentScript ||
    Array.from(document.scripts).find(s => /widget\.js(\?|$)/.test(s.src));
  if (!scriptTag) {
    console.warn('[Praxmate] widget.js could not locate its script tag');
    return;
  }

  const cfg = {
    practice: scriptTag.dataset.practice || '',
    mode: (scriptTag.dataset.mode || 'floating').toLowerCase(),
    color: scriptTag.dataset.color || '#0ea5e9',
    label: scriptTag.dataset.label || 'Termin online buchen',
    source: scriptTag.dataset.source || '',
    host: scriptTag.dataset.host || (new URL(scriptTag.src).origin),
  };

  if (!cfg.practice) {
    console.warn('[Praxmate] widget.js: data-practice attribute is required');
    return;
  }

  // Avoid double-load
  if (window.__praxmateWidgetLoaded) return;
  window.__praxmateWidgetLoaded = true;

  // --- Build iframe URL ---
  function buildIframeUrl(extraSource) {
    const params = new URLSearchParams();
    params.set('practice', cfg.practice);
    const src = extraSource || cfg.source;
    params.set('embed', src === 'minimal' ? 'minimal' : '1');
    return cfg.host + '/book.html?' + params.toString();
  }

  // --- Inject base styles once ---
  function injectStyles() {
    if (document.getElementById('praxmate-widget-styles')) return;
    const css = `
      .pmw-fab {
        position: fixed; bottom: 24px; right: 24px;
        z-index: 999998;
        background: ${cfg.color};
        color: white;
        border: none;
        border-radius: 100px;
        padding: 14px 24px 14px 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 15px; font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(0,0,0,0.2), 0 4px 8px rgba(0,0,0,0.1);
        display: inline-flex; align-items: center; gap: 10px;
        transition: transform 0.18s cubic-bezier(0.16,1,0.3,1), box-shadow 0.18s;
        line-height: 1;
      }
      .pmw-fab:hover { transform: translateY(-2px); box-shadow: 0 14px 36px rgba(0,0,0,0.25); }
      .pmw-fab-icon {
        width: 22px; height: 22px;
        background: rgba(255,255,255,0.2);
        border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 14px;
      }
      .pmw-overlay {
        position: fixed; inset: 0;
        z-index: 999999;
        background: rgba(10,14,26,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: none;
        align-items: center; justify-content: center;
        padding: 20px;
        animation: pmw-fade 0.2s ease;
      }
      .pmw-overlay.pmw-open { display: flex; }
      @keyframes pmw-fade { from { opacity: 0; } to { opacity: 1; } }
      .pmw-modal {
        background: white;
        border-radius: 18px;
        max-width: 720px;
        width: 100%;
        max-height: 92vh;
        position: relative;
        box-shadow: 0 30px 80px rgba(0,0,0,0.4);
        overflow: hidden;
        animation: pmw-pop 0.25s cubic-bezier(0.16,1,0.3,1);
      }
      @keyframes pmw-pop {
        from { opacity: 0; transform: translateY(20px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .pmw-close {
        position: absolute; top: 10px; right: 10px;
        z-index: 2;
        width: 34px; height: 34px;
        background: rgba(0,0,0,0.06);
        backdrop-filter: blur(6px);
        border: none; border-radius: 50%;
        font-size: 18px; cursor: pointer;
        color: #1a2a3a;
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, sans-serif;
      }
      .pmw-close:hover { background: rgba(0,0,0,0.12); }
      .pmw-iframe {
        width: 100%;
        height: 92vh;
        max-height: 92vh;
        border: 0;
        display: block;
      }
      .pmw-inline-frame {
        width: 100%;
        min-height: 700px;
        border: 0;
        display: block;
        border-radius: 12px;
      }
      @media (max-width: 540px) {
        .pmw-fab { bottom: 16px; right: 16px; padding: 12px 18px 12px 14px; font-size: 14px; }
        .pmw-modal { border-radius: 12px; }
        .pmw-iframe { height: 96vh; max-height: 96vh; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'praxmate-widget-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --- Modal singleton ---
  let modalEl = null;
  let iframeLoaded = false;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'pmw-overlay';
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-label', 'Termin buchen');
    modalEl.innerHTML = `
      <div class="pmw-modal">
        <button class="pmw-close" aria-label="Schließen">✕</button>
        <iframe class="pmw-iframe" src="about:blank"></iframe>
      </div>
    `;
    document.body.appendChild(modalEl);
    // Close on overlay click
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeModal();
    });
    modalEl.querySelector('.pmw-close').addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl.classList.contains('pmw-open')) closeModal();
    });
    return modalEl;
  }

  function openModal() {
    const m = ensureModal();
    if (!iframeLoaded) {
      m.querySelector('iframe').src = buildIframeUrl();
      iframeLoaded = true;
    }
    m.classList.add('pmw-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('pmw-open');
    document.body.style.overflow = '';
  }

  // --- Mode: FLOATING ---
  function initFloating() {
    const btn = document.createElement('button');
    btn.className = 'pmw-fab';
    btn.type = 'button';
    btn.setAttribute('aria-label', cfg.label);
    btn.innerHTML = `<span class="pmw-fab-icon">📅</span><span>${escapeHtml(cfg.label)}</span>`;
    btn.addEventListener('click', openModal);
    document.body.appendChild(btn);
  }

  // --- Mode: INLINE ---
  function initInline() {
    const containers = document.querySelectorAll('[data-praxmate-widget]');
    if (!containers.length) {
      console.warn('[Praxmate] mode=inline but no <div data-praxmate-widget> found');
      return;
    }
    containers.forEach(container => {
      const iframe = document.createElement('iframe');
      iframe.className = 'pmw-inline-frame';
      iframe.setAttribute('title', 'Termin buchen');
      iframe.src = buildIframeUrl();
      container.appendChild(iframe);
    });
  }

  // --- Mode: POPUP ---
  function initPopup() {
    const triggers = document.querySelectorAll('[data-praxmate-trigger]');
    if (!triggers.length) {
      console.warn('[Praxmate] mode=popup but no [data-praxmate-trigger] found');
      return;
    }
    triggers.forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
    });
  }

  // --- Helpers ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // --- Boot ---
  function boot() {
    injectStyles();
    if (cfg.mode === 'inline') initInline();
    else if (cfg.mode === 'popup') initPopup();
    else initFloating();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose API for advanced use
  window.Praxmate = {
    open: openModal,
    close: closeModal,
    config: cfg,
  };
})();
// v0.7.2 widget
