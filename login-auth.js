// login-auth.js — RepsRecord sign-in + sign-up logic.
// Loaded ONLY by login.html. Never loads app.js.

const SUPABASE_URL = 'https://ehuttijifubonhhgnvzx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodXR0aWppZnVib25oaGdudnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjU2MTgsImV4cCI6MjA5NTA0MTYxOH0.-uYE8sxRDXdZXt00CH10d7tLYaJl03hFYfDH5tPjTKM';
const APP_PAGE = 'app.html';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

// ── Helpers ──
function showMsg(text, ok) {
  const m = $('msg');
  if (!m) return;
  m.textContent = text || '';
  m.style.display = text ? 'block' : 'none';
  m.style.background = ok ? '#ECFDF5' : '#FEF2F2';
  m.style.borderColor = ok ? '#6EE7B7' : '#FECACA';
  m.style.color = ok ? '#065F46' : '#991B1B';
}

function goApp() {
  const plan = new URLSearchParams(window.location.search).get('plan');
  window.location.replace(plan ? `${APP_PAGE}?checkout=${plan}` : APP_PAGE);
}

function showConfirmScreen(email) {
  $('signin-section').style.display = 'none';
  $('signup-section').style.display = 'none';
  $('mode-tabs').style.display = 'none';
  $('plan-badge').style.display = 'none';
  $('msg').style.display = 'none';
  $('confirm-email-shown').textContent = email;
  $('confirm-screen').style.display = 'block';
}

// ── Mode switching ──
function setMode(mode) {
  showMsg('');
  if (mode === 'signin') {
    $('signin-section').style.display = 'block';
    $('signup-section').style.display = 'none';
    $('tab-signin').classList.add('active');
    $('tab-signup').classList.remove('active');
    setTimeout(() => $('email')?.focus(), 50);
  } else {
    $('signin-section').style.display = 'none';
    $('signup-section').style.display = 'block';
    $('tab-signin').classList.remove('active');
    $('tab-signup').classList.add('active');
    setTimeout(() => $('signup-email')?.focus(), 50);
  }
}

// ── Already signed in? ──
sb.auth.onAuthStateChange((_event, session) => { if (session) goApp(); });

(async () => {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) goApp();
  } catch (e) {}
})();

// ── Sign In ──
async function signInEmail() {
  const email = ($('email')?.value || '').trim();
  const password = $('password')?.value || '';
  if (!email || !password) { showMsg('Enter your email and password.'); return; }
  const btn = $('signin-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  showMsg('');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showMsg(error.message || 'Could not sign in. Check your email and password.');
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      return;
    }
    // Success: onAuthStateChange handles the redirect
  } catch (e) {
    showMsg('Something went wrong. Please try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
}

// ── Sign Up ──
async function signUpEmail() {
  const email = ($('signup-email')?.value || '').trim();
  const password = $('signup-password')?.value || '';
  const password2 = $('signup-password2')?.value || '';
  if (!email) { showMsg('Please enter your email address.'); return; }
  if (!password) { showMsg('Please create a password.'); return; }
  if (password.length < 8) { showMsg('Password must be at least 8 characters.'); return; }
  if (password !== password2) { showMsg('Passwords don\'t match — please try again.'); return; }
  const btn = $('signup-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }
  showMsg('');
  try {
    const plan = new URLSearchParams(window.location.search).get('plan') || 'monthly';
    const { error } = await sb.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin + `/login.html?plan=${plan}`,
        data: { plan }
      }
    });
    if (error) {
      showMsg(error.message || 'Could not create account. Please try again.');
      if (btn) { btn.disabled = false; btn.textContent = 'Create account & start trial'; }
      return;
    }
    // Show confirmation screen
    showConfirmScreen(email);
  } catch (e) {
    showMsg('Something went wrong. Please try again.');
    if (btn) { btn.disabled = false; btn.textContent = 'Create account & start trial'; }
  }
}

// ── Google OAuth ──
async function signInGoogle() {
  showMsg('');
  try {
    const plan = new URLSearchParams(window.location.search).get('plan') || '';
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/login.html' + (plan ? `?plan=${plan}` : '') }
    });
    if (error) showMsg(error.message || 'Could not start Google sign-in.');
  } catch (e) {
    showMsg('Could not start Google sign-in. Please try again.');
  }
}

// ── Forgot Password ──
async function forgotPassword() {
  const email = ($('email')?.value || '').trim();
  if (!email) { showMsg('Enter your email above first, then click "Forgot password?".'); return; }
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

// ── DOM Ready ──
document.addEventListener('DOMContentLoaded', () => {
  // Mode tabs
  $('tab-signin')?.addEventListener('click', () => setMode('signin'));
  $('tab-signup')?.addEventListener('click', () => setMode('signup'));
  $('back-to-signin')?.addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); });

  // Sign in form
  $('signin-form')?.addEventListener('submit', (e) => { e.preventDefault(); signInEmail(); });
  $('google-btn-signin')?.addEventListener('click', signInGoogle);
  $('forgot-link')?.addEventListener('click', (e) => { e.preventDefault(); forgotPassword(); });
  $('email')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('password')?.focus(); } });

  // Sign up form
  $('signup-form')?.addEventListener('submit', (e) => { e.preventDefault(); signUpEmail(); });
  $('google-btn-signup')?.addEventListener('click', signInGoogle);

  // Show plan badge if arriving from pricing CTA
  const plan = new URLSearchParams(window.location.search).get('plan');
  if (plan) {
    const badge = $('plan-badge');
    if (badge) {
      const label = plan === 'annual' ? 'Annual — $199/yr (save 43%)' : 'Monthly — $29/mo';
      badge.innerHTML = `✅ <strong>${label}</strong> · 7-day free trial included`;
      badge.style.display = 'block';
    }
    // Auto-switch to signup tab if arriving from pricing
    setMode('signup');
  }
});
