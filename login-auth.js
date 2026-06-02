// ─────────────────────────────────────────────────────────────────────────────
// login-auth.js — RepsRecord sign-in logic.
// Loaded ONLY by login.html. It must NEVER load app.js (that would re-introduce
// the redirect loop). This page's only job is: authenticate, then send the user
// to the app. It only redirects when a session EXISTS, so it can never loop.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://ehuttijifubonhhgnvzx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodXR0aWppZnVib25oaGdudnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjU2MTgsImV4cCI6MjA5NTA0MTYxOH0.-uYE8sxRDXdZXt00CH10d7tLYaJl03hFYfDH5tPjTKM';

// Where authenticated users land. This MUST be the app shell page (the file that
// loads app.js) — NOT this page.
const APP_PAGE = 'app.html';

// Where new users go to start a trial — the pricing cards, so they pick a plan first.
const TRIAL_LINK = 'index.html#pricing'; // send new users to plan selection, not straight to Monthly checkout

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);

function showMsg(text, ok) {
  const m = $('msg');
  if (!m) return;
  m.textContent = text || '';
  m.style.display = text ? 'block' : 'none';
  if (ok) {
    m.style.background = '#ECFDF5';
    m.style.borderColor = '#6EE7B7';
    m.style.color = '#065F46';
  } else {
    m.style.background = '#FEF2F2';
    m.style.borderColor = '#FECACA';
    m.style.color = '#991B1B';
  }
}

function setBusy(b) {
  const btn = $('signin-btn');
  if (btn) { btn.disabled = b; btn.textContent = b ? 'Signing in…' : 'Sign in'; }
}

function goApp() {
  // replace() so the back button doesn't return to this sign-in page.
  window.location.replace(APP_PAGE);
}

// Already signed in, or just returned from a Google / password-reset redirect?
// Supabase parses the URL session automatically; this fires once it's ready.
sb.auth.onAuthStateChange((_event, session) => { if (session) goApp(); });

(async () => {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) goApp();
  } catch (e) {
    // No session yet — just show the form. (Never redirect here.)
  }
})();

async function signInEmail() {
  const email = ($('email')?.value || '').trim();
  const password = $('password')?.value || '';
  if (!email || !password) { showMsg('Enter your email and password.'); return; }
  setBusy(true);
  showMsg('');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showMsg(error.message || 'Could not sign in. Check your email and password.');
      setBusy(false);
      return;
    }
    // Success: onAuthStateChange handles the redirect to the app.
  } catch (e) {
    showMsg('Something went wrong signing in. Please try again.');
    setBusy(false);
  }
}

async function signInGoogle() {
  showMsg('');
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/login.html' }
    });
    if (error) showMsg(error.message || 'Could not start Google sign-in.');
  } catch (e) {
    showMsg('Could not start Google sign-in. Please try again.');
  }
}

async function forgotPassword() {
  const email = ($('email')?.value || '').trim();
  if (!email) { showMsg('Enter your email above first, then click “Forgot password?”.'); return; }
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/login.html'
    });
    if (error) showMsg(error.message || 'Could not send the reset email.');
    else showMsg('Password reset email sent — check your inbox.', true);
  } catch (e) {
    showMsg('Could not send the reset email. Please try again.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('signin-btn')?.addEventListener('click', signInEmail);
  $('google-btn')?.addEventListener('click', signInGoogle);
  $('forgot-link')?.addEventListener('click', (e) => { e.preventDefault(); forgotPassword(); });
  const trial = $('trial-link');
  if (trial) trial.href = TRIAL_LINK;

  // Enter-to-submit
  $('email')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('password')?.focus(); } });
  $('password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); signInEmail(); } });
});
