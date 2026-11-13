// Same theme logic and storage key as kushshriv.github.io, so the choice carries over between the sites.
(() => {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let pref = 'system';
  try { const s = localStorage.getItem('site-theme'); if (s === 'light' || s === 'dark') pref = s; } catch (_) {}
  const apply = () => {
    document.documentElement.dataset.theme = pref === 'system' ? (system.matches ? 'dark' : 'light') : pref;
    document.dispatchEvent(new Event('themechange'));
  };
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    const c = document.getElementById('theme');
    if (!c) return;
    c.querySelector(`input[value="${pref}"]`).checked = true;
    c.addEventListener('change', e => {
      pref = e.target.value;
      try { localStorage.setItem('site-theme', pref); } catch (_) {}
      apply();
    });
  });
})();
