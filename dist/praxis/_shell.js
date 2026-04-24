// Sidebar bootstrap - runs on every page with the shell
(function() {
  const API_BASE = 'https://praxmate-api.hguencavdi.workers.dev/api';
  const token = localStorage.getItem('praxmate_token');
  if (!token) return;

  // Resolve practice slug (same logic as elsewhere)
  function resolvePracticeSlug() {
    const host = window.location.hostname;
    const RESERVED = ['www','admin','api','app','mail','praxmate'];
    let m = host.match(/^([a-z0-9-]+)\.praxmate\.de$/);
    if (m && !RESERVED.includes(m[1])) return m[1];
    m = host.match(/^([a-z0-9-]+)\.praxmate\.pages\.dev$/);
    if (m && !RESERVED.includes(m[1]) && !/^[a-f0-9]{8}$/.test(m[1])) return m[1];
    const qs = new URLSearchParams(window.location.search);
    const qp = qs.get('practice');
    if (qp) { localStorage.setItem('praxmate_practice', qp); return qp; }
    return localStorage.getItem('praxmate_practice');
  }
  const slug = resolvePracticeSlug();

  // Highlight active page from body data attribute
  const activePage = document.body.dataset.page;
  if (activePage) {
    document.querySelectorAll('.sb-nav-item').forEach(a => {
      a.classList.toggle('active', a.dataset.page === activePage);
    });
  }

  // ===== i18n: translate sidebar labels (reactive to language changes) =====
  const SB_LABELS = {
    'dashboard':      'sb.dashboard',
    'new-appointment':'sb.new_appt',
    'calendar':       'sb.calendar',
    'patients':       'sb.patients',
    'settings':       'sb.settings',
  };
  function applyI18n() {
    if (!window.i18n) return;
    document.querySelectorAll('.sb-nav-item[data-page]').forEach(a => {
      const key = SB_LABELS[a.dataset.page];
      const textSpan = a.querySelector('span:last-child');
      if (key && textSpan) textSpan.textContent = window.i18n.t(key);
    });
    // role label under user name
    const roleEl = document.getElementById('sbUserRole');
    if (roleEl && roleEl.dataset.role) {
      roleEl.textContent = window.i18n.t('role.' + roleEl.dataset.role);
    }
    // logout tooltip
    const userBox = document.getElementById('sbUser');
    if (userBox) userBox.title = window.i18n.t('sb.logout');
  }
  applyI18n();
  if (window.i18n) window.i18n.onChange(applyI18n);

  // Preserve ?practice= in nav links if we're using query-param routing
  if (slug && window.location.search.includes('practice=')) {
    document.querySelectorAll('.sb-nav-item').forEach(a => {
      const u = new URL(a.href, window.location.origin);
      if (!u.searchParams.has('practice')) u.searchParams.set('practice', slug);
      a.href = u.pathname + u.search + u.hash;
    });
  }

  // Mobile toggle
  const sidebar = document.querySelector('.app-sidebar');
  const toggle = document.getElementById('sbToggle');
  if (toggle && sidebar) {
    // Add backdrop
    let backdrop = document.querySelector('.sb-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'sb-backdrop';
      document.body.appendChild(backdrop);
    }
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('visible');
    });
    backdrop.addEventListener('click', () => {
      sidebar.classList.remove('open');
      backdrop.classList.remove('visible');
    });
    // Close on nav click (mobile)
    sidebar.querySelectorAll('.sb-nav-item').forEach(a => {
      a.addEventListener('click', () => {
        if (window.innerWidth < 900) {
          sidebar.classList.remove('open');
          backdrop.classList.remove('visible');
        }
      });
    });
  }

  // Logout on user box click
  const userBox = document.getElementById('sbUser');
  if (userBox) {
    userBox.addEventListener('click', async () => {
      if (!confirm((window.i18n && window.i18n.t('sb.confirm_logout')) || 'Abmelden?')) return;
      try {
        await fetch(API_BASE + '/admin/auth/logout', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            ...(slug ? { 'X-Praxmate-Practice': slug } : {}),
          },
        });
      } catch {}
      localStorage.removeItem('praxmate_token');
      window.location.href = '/praxis/' + (slug ? '?practice=' + slug : '');
    });
  }

  // Fetch user + practice info, fill sidebar
  (async function fillSidebar() {
    try {
      const res = await fetch(API_BASE + '/admin/auth/me', {
        headers: {
          'Authorization': 'Bearer ' + token,
          ...(slug ? { 'X-Praxmate-Practice': slug } : {}),
        },
      });
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('praxmate_token');
          window.location.href = '/praxis/' + (slug ? '?practice=' + slug : '');
        }
        return;
      }
      const data = await res.json();
      const u = data.user || {};
      const p = data.practice || {};

      const roleLabels = { owner: 'Inhaber', doctor: 'Behandler', staff: 'Team' };
      const nameEl = document.getElementById('sbUserName');
      const roleEl = document.getElementById('sbUserRole');
      const avaEl = document.getElementById('sbUserAvatar');
      const subEl = document.getElementById('sbBrandSub');
      const markEl = document.getElementById('sbBrandMark');

      if (nameEl) nameEl.textContent = u.name || '';
      if (roleEl) {
        // Store raw role for later re-translation on lang change
        if (u.role) roleEl.dataset.role = u.role;
        roleEl.textContent = (window.i18n && u.role) ? window.i18n.t('role.' + u.role) : (roleLabels[u.role] || u.role || '');
      }
      if (avaEl) avaEl.textContent = (u.name || '?').split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();
      if (subEl && p.name) subEl.textContent = p.name;

      // If practice has a logo_url, load it
      if (markEl) {
        try {
          const detailRes = await fetch(API_BASE + '/admin/practice/settings', {
            headers: {
              'Authorization': 'Bearer ' + token,
              ...(slug ? { 'X-Praxmate-Practice': slug } : {}),
            },
          });
          if (detailRes.ok) {
            const detail = await detailRes.json();
            if (detail?.logo_url) {
              markEl.innerHTML = `<img src="${detail.logo_url}" alt="">`;
            }
          }
        } catch {}
      }

      // Brand color override
      if (p.brand_primary) {
        document.documentElement.style.setProperty('--primary', p.brand_primary);
      }

      // i18n: if user hasn't explicitly chosen a language, follow tenant locale.
      // practice.locale looks like 'tr-TR' / 'en-GB' / 'de-DE'.
      if (window.i18n && p.locale && !localStorage.getItem('praxmate_lang')) {
        window.i18n.setLang(p.locale);
      }
    } catch (e) {
      console.warn('Sidebar fill failed:', e);
    }
  })();
})();
