// ─────────────────────────────────────────────────────────────────────────────
// signup-auth.js — RepsRecord account creation (post-payment).
// Loaded ONLY by signup.html. New users land here AFTER paying at Stripe.
// Stripe's success URL is configured as:
//   https://repsrecord.com/signup.html?session_id={CHECKOUT_SESSION_ID}&prefilled_email=...
//
// SAFER MIDDLE STEP (no server / no secret key):
//   • Gate 1 — require a Stripe checkout session_id in the URL. A direct visitor
//     (no payment) has none, so they can't create an account here.
//   • Gate 2 — the email is locked to the address that paid (read-only).
//   • Gate 3 — the Stripe session_id is recorded on the account (user metadata)
//     so every account is traceable to a checkout for later reconciliation.
//
// NOTE (honest limit): this verifies a session_id is PRESENT, not that Stripe
// confirmed it as paid (that needs a server-side Stripe call / webhook). It stops
// direct sign-ups and email mismatches, not a determined actor with a real id.
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://ehuttijifubonhhgnvzx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVodXR0aWppZnVib25oaGdudnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NjU2MTgsImV4cCI6MjA5NTA0MTYxOH0.-uYE8sxRDXdZXt00CH10d7tLYaJl03hFYfDH5tPjTKM';
// Where authenticated users land — the app shell page (loads app.js).
const APP_PAGE = 'app.html';
// Where to send someone who reached signup without a Stripe session (no payment).
const TRIAL_PAGE = 'index.html#pricing';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
// Pull Stripe context from the URL once.
function getCtx() {
  try {
    const p = new URLSearchParams(window.location.search);
    return {
      sessionId: p.get('session_id') || '',
      email: (p.get('prefilled_email') || p.get('email') || '').trim()
    };
  } catch (e) { return { sessionId: '', email: '' }; }
}
const CTX = getCtx();
// A real Stripe Checkout Session id starts with "cs_". Accept that prefix.
const HAS_VALID_SESSION = /^cs_[A-Za-z0-9_]+$/.test(CTX.sessionId);
function showMsg(text, ok) {
  const m = $('msg');
  if (!m) return;
  m.textContent = text || '';
  m.style.display = text ? 'block' : 'none';
  if (ok) {
    m.style.background = '#ECFDF5'; m.style.borderColor = '#6EE7B7'; m.style.color = '#065F46';
  } else {
    m.style.background = '#FEF2F2'; m.style.borderColor = '#FECACA'; m.style.color = '#991B1B';
  }
}
function setBusy(b) {
  const btn = $('signup-btn');
  if (btn) { btn.disabled = b; btn.textContent = b ? 'Creating account…' : 'Create account'; }
}
// Endpoint that verifies the Stripe payment and links the subscription to the new user.
const CLAIM_ENDPOINT = SUPABASE_URL + '/functions/v1/claim-subscription';
// Read-only endpoint that returns the email for a paid Stripe session (autofill).
const SESSION_EMAIL_ENDPOINT = SUPABASE_URL + '/functions/v1/session-email';
// Set true while we're creating+claiming so the auth-state listener doesn't redirect early.
let CLAIMING = false;
function goApp() { window.location.replace(APP_PAGE); }
// If a session already exists (e.g. revisit), send to the app — but NOT while we're
// in the middle of the signup+claim flow (we redirect ourselves after claiming).
sb.auth.onAuthStateChange((_event, session) => { if (session && !CLAIMING) goApp(); });
(async () => {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session) { goApp(); return; }
  } catch (e) { /* no session — continue */ }
  await applyGates();
})();
// Set up the form based on the Stripe context (Gates 1 & 2).
async function applyGates() {
  const emailEl = $('email');
  const banner = document.querySelector('.welcome');
  if (!HAS_VALID_SESSION) {
    // Gate 1: no payment session — block account creation, point them to pricing.
    if (banner) {
      banner.style.background = '#FEF2F2';
      banner.style.borderColor = '#FECACA';
      banner.style.color = '#991B1B';
      banner.textContent = 'To create an account, please start your free trial first.';
    }
    const btn = $('signup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Start your trial first'; btn.onclick = () => { window.location.href = TRIAL_PAGE; }; btn.disabled = false; }
    const g = $('google-btn'); if (g) g.style.display = 'none';
    if (emailEl) emailEl.disabled = true;
    const pw = $('password'); if (pw) pw.disabled = true;
    return;
  }
  // Gate 2: lock the email to the address that paid (if Stripe passed it).
  if (CTX.email && emailEl) {
    emailEl.value = CTX.email;
    emailEl.readOnly = true;
    emailEl.style.background = '#F1F5F9';
    emailEl.style.color = '#475569';
    emailEl.setAttribute('aria-readonly', 'true');
    const hint = emailEl.parentElement && emailEl.parentElement.querySelector('.hint');
    // (email field has no hint by default; the locked styling signals it's fixed)
  } else if (emailEl) {
    // Session present but no email in the URL — fetch it from Stripe (read-only) and lock it.
    emailEl.placeholder = 'Loading your email…';
    try {
      const res = await fetch(SESSION_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: CTX.sessionId })
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out && out.email) {
        CTX.email = out.email; // remember it for the claim step
        emailEl.value = out.email;
        emailEl.readOnly = true;
        emailEl.style.background = '#F1F5F9';
        emailEl.style.color = '#475569';
        emailEl.setAttribute('aria-readonly', 'true');
      } else {
        emailEl.placeholder = 'Use the email you paid with';
      }
    } catch (e) {
      emailEl.placeholder = 'Use the email you paid with';
    }
  }
}
// After the account exists and we have a session, verify the payment and write the
// subscription row. Returns true on success.
async function claimSubscription() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return false;
    const res = await fetch(CLAIM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ session_id: CTX.sessionId })
    });
    const out = await res.json().catch(() => ({}));
    return res.ok && out && out.ok === true;
  } catch (e) {
    return false;
  }
}
// Poll until (a) a session token exists and (b) the subscriptions row is readable
// for this user. Prevents the post-signup paywall from firing before data is ready.
async function waitForReady() {
  for (let i = 0; i < 12; i++) { // up to ~3s
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (session && session.access_token) {
        const res = await fetch(SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + session.user.id + '&select=status', {
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + session.access_token }
        });
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          if (Array.isArray(rows) && rows.length && ['trialing','active','past_due'].includes(rows[0].status)) return true;
        }
      }
    } catch (e) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false; // fall through; app's own paywall will re-check
}
async function signUpEmail() {
  if (!HAS_VALID_SESSION) { window.location.href = TRIAL_PAGE; return; }
  // If the email is locked, always use the paid email; otherwise read the field.
  const email = (CTX.email || ($('email')?.value || '')).trim();
  const password = $('password')?.value || '';
  if (!email) { showMsg('We couldn’t read your email. Please contact support@repsrecord.com.'); return; }
  if (!password) { showMsg('Please choose a password.'); return; }
  if (password.length < 8) { showMsg('Please use a password of at least 8 characters.'); return; }
  setBusy(true);
  showMsg('');
  try {
    CLAIMING = true; // hold the auto-redirect until we've claimed
    // Try to CREATE the account with the typed password.
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { stripe_session_id: CTX.sessionId, signup_source: 'stripe_checkout' } }
    });
    let signedIn = !!(data && data.session);
    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
        // Account already exists (returning customer). Sign in with the typed password.
        const { error: siErr } = await sb.auth.signInWithPassword({ email, password });
        if (siErr) {
          CLAIMING = false;
          showMsg('This email already has an account. Please sign in with your existing password — your new payment will be applied automatically once you do.');
          setBusy(false);
          return;
        }
        signedIn = true;
      } else {
        CLAIMING = false;
        showMsg(error.message || 'Could not create your account. Please try again.');
        setBusy(false);
        return;
      }
    }
    if (!signedIn) {
      const { error: siErr } = await sb.auth.signInWithPassword({ email, password });
      if (siErr) { CLAIMING = false; showMsg('Account created, but we could not sign you in. Please sign in to continue.'); setBusy(false); return; }
    }
    // Link the payment to this account (verifies the Stripe session is really paid).
    const claimed = await claimSubscription();
    if (!claimed) {
      CLAIMING = false;
      showMsg('Your account is ready, but we could not confirm your payment automatically. Please email support@repsrecord.com and we will activate it right away.');
      setBusy(false);
      return;
    }
    // Confirm session + subscription are readable, then enter the app.
    await waitForReady();
    goApp();
  } catch (e) {
    showMsg('Something went wrong creating your account. Please try again.');
    setBusy(false);
  }
}
async function signUpGoogle() {
  if (!HAS_VALID_SESSION) { window.location.href = TRIAL_PAGE; return; }
  showMsg('');
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      // Carry the session id through the OAuth round-trip so it survives the redirect.
      options: { redirectTo: window.location.origin + '/signup.html?session_id=' + encodeURIComponent(CTX.sessionId) }
    });
    if (error) showMsg(error.message || 'Could not start Google sign-up.');
  } catch (e) {
    showMsg('Could not start Google sign-up. Please try again.');
  }
}
document.addEventListener('DOMContentLoaded', () => {
  $('signup-btn')?.addEventListener('click', signUpEmail);
  $('google-btn')?.addEventListener('click', signUpGoogle);
  $('email')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('password')?.focus(); } });
  $('password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); signUpEmail(); } });
  $('pw-toggle')?.addEventListener('click', (e) => {
    e.preventDefault();
    const p = $('password'); const t = $('pw-toggle');
    if (!p || !t) return;
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    t.textContent = show ? '🙈' : '👁';
    t.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    p.focus();
  });
});
