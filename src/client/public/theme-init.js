// Applies the stored theme before first paint, so an e-ink screen never flashes the dark theme.
// Kept in sync with lib/theme.ts (STORAGE_KEY, CHROME); a separate file because the CSP forbids inline scripts.
try {
  var theme = localStorage.getItem('qc.theme')
  if (theme === 'light' || theme === 'eink') {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'light' ? '#f9fafb' : '#ffffff')
  }
} catch { /* private mode */ }
