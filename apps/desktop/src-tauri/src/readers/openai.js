(() => {
  if (window.top !== window) return;
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const iso = (v) => {
    const time = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
    const date = new Date(time);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const get = async (path) => {
    try {
      const r = await fetch(path, { credentials: 'include', redirect: 'error' });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  const run = async () => {
    if (location.hostname !== 'platform.openai.com') { report({ signedIn: false, reason: 'signin' }); return; }
    const deadline = Date.now() + 25000;
    while (challenged() && Date.now() < deadline) await wait(500);
    if (challenged()) { report({ signedIn: false, reason: 'challenge' }); return; }
    if (/\/(login|auth|signup)(\/|$)/.test(location.pathname)) { report({ signedIn: false, reason: 'signin' }); return; }
    const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    // These private paths are candidates; the visible labels remain a fallback when their schemas change.
    let credits = await get('/dashboard/billing/credit_grants');
    if (!credits) credits = await get('/v1/dashboard/billing/credit_grants');
    let usage = await get('/dashboard/billing/usage?start_date=' + start + '&end_date=' + end);
    if (!usage) usage = await get('/v1/dashboard/billing/usage?start_date=' + start + '&end_date=' + end);
    const account = { balance: count(credits && credits.total_available), spend: null, promos: [] };
    if (count(usage && usage.total_usage) !== null) account.spend = usage.total_usage / 100;
    const grants = credits && credits.grants;
    const rows = Array.isArray(grants) ? grants : grants && Array.isArray(grants.data) ? grants.data : [];
    for (const grant of rows) {
      if (!grant || !/promo|free|trial/i.test(String(grant.type || grant.grant_type || grant.name || ''))) continue;
      const remaining = count(grant.remaining_amount) ?? count(grant.remaining);
      if (remaining === null) continue;
      account.promos.push({ remaining, expiresAt: iso(grant.expires_at) });
    }
    const text = document.body && document.body.innerText || '';
    const amount = (label) => {
      const match = text.match(new RegExp('(?:' + label + ')\\s*[:\\n]?\\s*(?:USD\\s*|\\$)(-?[0-9][0-9,]*(?:\\.[0-9]+)?)', 'i'));
      return match ? Number(match[1].replace(/,/g, '')) : null;
    };
    if (account.balance === null) account.balance = amount('credit balance|prepaid balance|prepaid credits');
    if (account.spend === null) account.spend = amount('usage this month|spend this month|month to date|monthly spend');
    if (!account.promos.length) {
      const remaining = amount('promotional credits?|free credits?|trial credits?');
      const expiry = text.match(/(?:promotional|free|trial) credits?[\s\S]{0,160}?(?:expires?|ends?)\s*(?:on\s+)?([A-Za-z]+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})/i);
      if (remaining !== null) account.promos.push({ remaining, expiresAt: expiry ? iso(expiry[1]) : null });
    }
    if (!credits && !usage && account.balance === null && account.spend === null && !account.promos.length) {
      const signedOut = /sign in|log in|create an account/i.test(text) || !/billing|credit balance|payment method/i.test(text);
      report(signedOut ? { signedIn: false, reason: 'signin' } : { signedIn: true, account });
      return;
    }
    report({ signedIn: true, account });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
