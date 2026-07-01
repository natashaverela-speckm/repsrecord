// Runs in <head>, before the sign-in form paints. On a Google/OAuth return the session token
// arrives in the URL (hash or ?code=). In that case, cover the page with a neutral loader
// immediately so the sign-in form never flashes before login-auth.js redirects onward.
(function () {
  try {
    var s = (window.location.hash || '') + (window.location.search || '');
    if (!/access_token|refresh_token|[?&]code=/.test(s)) return;
    function show() {
      var b = document.getElementById('login-boot');
      if (b) { b.style.display = 'flex'; return true; }
      return false;
    }
    // The overlay element may not exist yet (head runs before body). Try now, then on DOM ready.
    if (!show()) {
      document.addEventListener('DOMContentLoaded', show);
      // Also poll very briefly in case DOMContentLoaded already fired oddly.
      var tries = 0, iv = setInterval(function () { if (show() || ++tries > 20) clearInterval(iv); }, 10);
    }
  } catch (e) {}
})();
