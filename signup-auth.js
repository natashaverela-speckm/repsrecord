// ─────────────────────────────────────────────────────────────────────────────
// signup-auth.js — RepsRecord account creation.
// Loaded ONLY by signup.html. New users land here AFTER paying at Stripe
// (Stripe's success URL points to /signup.html). It creates the account and
// sends the user into the app. Mirrors login-auth.js conventions.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://ehuttijifubonhhgnvzx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodXR0aWppZnVib25oaGdudnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjU2MTgsImV4cCI6MjA5NTA0MTYxOH0.-uYE8sxRDXdZXt00CH10d7tLYaJl03hFYfDH5tPjTKM';

// Where authenticated users land — the app shell page (loads app.js).
const APP_PAGE = 'app.html';

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
  const btn = $('signup-btn');
  if (btn) { btn.disabled = b; btn.textContent = b ? 'Creating account…' : 'Create account'; }
}

function goApp() {
  // replace() so the back button doesn't return to this signup page.
  window.location.replace(APP_PAGE);
}

// If a session already exists (e.g. user revisits this page after signing up,
// or returns from a Google redirect), send them straight to the app.
sb.auth.onAuthStateChange((_event, session) => { if (session) goApp(); });

(async () => {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) goApp();
  } catch (e) {
    // No session yet — show the form.
  }
})();

async function signUpEmail() {
  const email = ($('email')?.value || '').trim();
  const password = $('password')?.value || '';
  if (!email || !password) { showMsg('Enter your email and a password.'); return; }
  if (password.length < 8) { showMsg('Please use a password of at least 8 characters.'); return; }
  setBusy(true);
  showMsg('');
  try {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      // Most common: the email already has an account.
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        showMsg('An account with this email already exists. Please sign in instead.');
      } else {
        showMsg(error.message || 'Could not create your account. Please try again.');
      }
      setBusy(false);
      return;
    }
    // With email confirmation OFF, signUp returns an active session and
    // onAuthStateChange fires goApp(). As a fallback (e.g. if confirmation is
    // ever turned back on), sign in with the same credentials to obtain a session.
    if (!data || !data.session) {
      const { error: siErr } = await sb.auth.signInWithPassword({ email, password });
      if (siErr) {
        showMsg('Account created. Please check your email to confirm, then sign in.');
        setBusy(false);
        return;
      }
    }
    // Success: onAuthStateChange handles the redirect to the app.
  } catch (e) {
    showMsg('Something went wrong creating your account. Please try again.');
    setBusy(false);
  }
}

async function signUpGoogle() {
  showMsg('');
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/signup.html' }
    });
    if (error) showMsg(error.message || 'Could not start Google sign-up.');
  } catch (e) {
    showMsg('Could not start Google sign-up. Please try again.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('signup-btn')?.addEventListener('click', signUpEmail);
  $('google-btn')?.addEventListener('click', signUpGoogle);

  // Pre-fill the email if Stripe passed it through the success URL
  // (e.g. /signup.html?email=...&prefilled_email=...). Reduces the chance the
  // user signs up with a different email than they paid with.
  try {
    const params = new URLSearchParams(window.location.search);
    const pre = params.get('prefilled_email') || params.get('email');
    if (pre && $('email')) $('email').value = pre;
  } catch (e) {}

  // Enter-to-submit
  $('email')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('password')?.focus(); } });
  $('password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); signUpEmail(); } });
});
