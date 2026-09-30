// Runs on each page load in the hidden claude.ai reader window. Claude's API does not report the limit
// resets an account holds, but claude.ai's own usage call lists them as grants with the resets left, the
// windows each clears and when it ends. The script asks every organization that can chat and reports the
// grants, or says why it could not: a Cloudflare check that did not pass, or a session that is not signed in.
(() => {
  if (window.top !== window) return;
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (v) => (typeof v === 'string' ? v.slice(0, 120) : null);
  const count = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  const run = async () => {
    if (location.hostname !== 'claude.ai') { report({ signedIn: false, reason: 'signin' }); return; }
    const deadline = Date.now() + 25000;
    while (challenged() && Date.now() < deadline) await wait(500);
    if (challenged()) { report({ signedIn: false, reason: 'challenge' }); return; }
    let orgs = null;
    try {
      const r = await fetch('/api/organizations', { credentials: 'include' });
      if (r.ok) orgs = await r.json();
    } catch (e) { /* treated as signed out below */ }
    if (!Array.isArray(orgs)) { report({ signedIn: false, reason: 'signin' }); return; }
    const grants = [];
    for (const org of orgs) {
      if (!org || typeof org.uuid !== 'string' || !Array.isArray(org.capabilities) || !org.capabilities.includes('chat')) continue;
      try {
        const r = await fetch('/api/organizations/' + encodeURIComponent(org.uuid) + '/usage?cedar_ember=1&skip_spend=1', { credentials: 'include' });
        if (!r.ok) continue;
        const usage = await r.json();
        const list = usage && usage.cedar_ember && Array.isArray(usage.cedar_ember.grants) ? usage.cedar_ember.grants : [];
        for (const g of list) {
          grants.push({ id: text(g.id), label: text(g.label), resetsLeft: count(g.resets_left), resetsTotal: count(g.resets_total),
            endsAt: text(g.ends_at), paused: g.paused === true, usableNow: g.usable_now === true, clears: Array.isArray(g.clears) ? g.clears.map(text).filter(Boolean) : [] });
        }
      } catch (e) { /* one organization failing leaves the others */ }
    }
    report({ signedIn: true, grants });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
