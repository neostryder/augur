// Runs on each page load in the hidden Claude Console reader window. The Admin API has no credit balance and is closed to individual
// organizations, but the Console's own billing page loads the balance, the promotional credit that is about to expire and this month's
// spend from three same-origin calls. The script asks every organization the account belongs to and reports each one that answers, or says
// why it could not: a Cloudflare check that did not pass, or a session that is not signed in.
(() => {
  if (window.top !== window) return;
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (v) => (typeof v === 'string' ? v.slice(0, 120) : null);
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const get = async (path) => {
    try {
      const r = await fetch(path, { credentials: 'include' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };

  const run = async () => {
    if (location.hostname !== 'platform.claude.com') { report({ signedIn: false, reason: 'signin' }); return; }
    const deadline = Date.now() + 25000;
    while (challenged() && Date.now() < deadline) await wait(500);
    if (challenged()) { report({ signedIn: false, reason: 'challenge' }); return; }
    const orgs = await get('/api/organizations');
    if (!Array.isArray(orgs)) { report({ signedIn: false, reason: 'signin' }); return; }
    const accounts = [];
    for (const org of orgs) {
      if (!org || typeof org.uuid !== 'string') continue;
      const base = '/api/organizations/' + encodeURIComponent(org.uuid);
      const credits = await get(base + '/prepaid/credits');
      if (!credits || count(credits.amount) === null) continue;
      const spend = await get(base + '/current_spend');
      const exponent = credits.balance && credits.balance.credits && count(credits.balance.credits.exponent) !== null ? credits.balance.credits.exponent : 2;
      const promos = Array.isArray(credits.promo_tranches) ? credits.promo_tranches.map((t) => ({
        name: text(t && t.name), remainingMinor: count(t && t.remaining_amount_minor_units), grantedMinor: count(t && t.granted_amount_minor_units),
        expiresAt: text(t && t.expires_at), grantedAt: text(t && t.granted_at) })) : [];
      accounts.push({ name: text(org.name), currency: text(credits.currency) || 'USD', exponent, balanceMinor: count(credits.amount), promos,
        spendMinor: spend ? count(spend.amount) : null, spendResetsAt: spend ? text(spend.resets_at) : null });
    }
    report({ signedIn: true, accounts });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
