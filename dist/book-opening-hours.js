// ============================================================
// Praxmate booking-page helpers
// ============================================================
// Three jobs:
//   1) Render tenant's opening hours from /api/practice opening_hours
//      into <div id="opening-hours">. Renders compactly (Mo–Mi 08–12 · 15–18).
//   2) Inject tenant phone into elements with [data-pm-phone] + their parent
//      <a class="pm-phone-link"> gets href="tel:...".
//   3) formatDate(iso, lang) — localised weekday+date for confirmation step.
//
// Schema note: DB column is `day_of_week` (1=Mo..7=So). API returns it as
// `weekday`. This helper expects the API shape, 1-7 values.
// ============================================================

window.PraxmateHours = (function () {
  'use strict';

  const LABELS = {
    de: ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
    en: ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    tr: ['', 'Pzt', 'Sal', 'Çrş', 'Prş', 'Cum', 'Cmt', 'Paz'],
  };
  const LOCALE = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR' };

  function apply(practice, opts) {
    const lang = (opts && opts.lang) || 'de';
    renderHours(practice && practice.opening_hours, LABELS[lang] || LABELS.de);
    injectPhone(practice && practice.phone);
  }

  function renderHours(hours, labels) {
    const el = document.getElementById('opening-hours');
    if (!el) return;
    if (!Array.isArray(hours) || hours.length === 0) {
      el.style.display = 'none';
      return;
    }
    // Map weekday → "08:00–12:00 · 15:00–18:00"
    const byDay = {};
    for (const h of hours) {
      byDay[h.weekday] = (h.spans || []).map(s => s.from + '–' + s.to).join(' · ');
    }
    // Group consecutive weekdays sharing identical spans (Mo–Mi pattern)
    const dayOrder = [1, 2, 3, 4, 5, 6, 7];
    const blocks = [];
    let curStart = null, curEnd = null, curSpans = null;
    for (const wd of dayOrder) {
      const spans = byDay[wd];
      if (!spans) {
        if (curStart != null) blocks.push({ from: curStart, to: curEnd, spans: curSpans });
        curStart = curEnd = curSpans = null;
        continue;
      }
      if (spans === curSpans) {
        curEnd = wd;
      } else {
        if (curStart != null) blocks.push({ from: curStart, to: curEnd, spans: curSpans });
        curStart = curEnd = wd;
        curSpans = spans;
      }
    }
    if (curStart != null) blocks.push({ from: curStart, to: curEnd, spans: curSpans });

    el.innerHTML = '';
    for (const b of blocks) {
      const dayLabel = (b.from === b.to)
        ? labels[b.from]
        : labels[b.from] + '–' + labels[b.to];
      const div = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = dayLabel;
      div.appendChild(strong);
      div.appendChild(document.createTextNode(' ' + b.spans));
      el.appendChild(div);
    }
    el.style.display = '';
  }

  function injectPhone(phone) {
    if (!phone) return;
    const text = String(phone).trim();
    const telHref = 'tel:' + text.replace(/[^\d+]/g, '');
    document.querySelectorAll('[data-pm-phone]').forEach(s => {
      s.textContent = text;
    });
    document.querySelectorAll('a.pm-phone-link').forEach(a => {
      a.setAttribute('href', telHref);
    });
  }

  // Reserved for future: localised static strings outside the React-style
  // template (e.g. "ICS DESCRIPTION:" etc.). For now nothing else to do.
  function injectDates(/* lang */) {
    /* no-op for v1 */
  }

  function formatDate(iso, lang) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString(LOCALE[lang] || LOCALE.de, {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    });
  }

  return { apply, injectDates, formatDate };
})();
