// Super-admin sidebar bootstrap
(function() {
  const API_BASE = 'https://praxmate-api.hguencavdi.workers.dev/api';
  const token = localStorage.getItem('praxmate_super_token');
  if (!token) {
    window.location.href = '/admin/';
    return;
  }

  // Active page highlight
  const activePage = document.body.dataset.page;
  if (activePage) {
    document.querySelectorAll('.sb-nav-item').forEach(a => {
      a.classList.toggle('active', a.dataset.page === activePage);
    });
  }

  // Mobile toggle
  const sidebar = document.querySelector('.app-sidebar');
  const toggle = document.getElementById('sbToggle');
  if (toggle && sidebar) {
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
    sidebar.querySelectorAll('.sb-nav-item:not(.disabled)').forEach(a => {
      a.addEventListener('click', () => {
        if (window.innerWidth < 900) {
          sidebar.classList.remove('open');
          backdrop.classList.remove('visible');
        }
      });
    });
  }

  // Logout via user box
  const userBox = document.getElementById('sbUser');
  if (userBox) {
    userBox.addEventListener('click', async () => {
      if (!confirm('Abmelden?')) return;
      try {
        await fetch(API_BASE + '/admin/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
        });
      } catch {}
      localStorage.removeItem('praxmate_super_token');
      window.location.href = '/admin/';
    });
  }

  // Fetch super-admin profile
  (async function fillSidebar() {
    try {
      const res = await fetch(API_BASE + '/admin/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('praxmate_super_token');
          window.location.href = '/admin/';
        }
        return;
      }
      const data = await res.json();
      const u = data.user || data || {};

      const nameEl = document.getElementById('sbUserName');
      const roleEl = document.getElementById('sbUserRole');
      const avaEl = document.getElementById('sbUserAvatar');

      if (nameEl) nameEl.textContent = u.name || u.email || 'Super-Admin';
      if (roleEl) roleEl.textContent = 'Super-Admin';
      if (avaEl) avaEl.textContent = (u.name || u.email || '?').split(/[\s@]+/).slice(0,2).map(w => w[0]).join('').toUpperCase();
    } catch (e) {
      console.warn('Sidebar fill failed:', e);
    }
  })();
})();
