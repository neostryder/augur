(() => {
  if (window.top !== window) return;
  const deadline = Date.now() + 25000;
  const readings = new Map();
  const count = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const date = (value) => {
    const time = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && Number.isFinite(new Date(time).getTime()) ? new Date(time).toISOString().slice(0, 10) : null;
  };
  const capture = async (response, url) => {
    if (!response.ok) return;
    const body = await response.clone().json();
    if (!body || !Array.isArray(body.data)) return;
    const ids = [...url.searchParams.getAll('project_ids'), ...url.searchParams.getAll('project_ids[]')];
    if (ids.length > 1 || ids.some(id => !id || id.includes(','))) return;
    const id = ids[0] || null, costs = url.pathname.endsWith('/costs');
    const range = [url.searchParams.get('start_time'), url.searchParams.get('end_time')].join(':');
    const key = [costs ? 'costs' : 'usage', id || '', range].join('|');
    let reading = readings.get(key);
    if (!reading || !url.searchParams.has('page')) reading = { id, costs, range, name: null, days: new Map(), complete: false };
    for (const bucket of body.data) {
      const start = date(bucket.start_time_iso) || date(bucket.start_time);
      if (!start || !Array.isArray(bucket.results)) continue;
      let spend = 0, requests = 0, tokens = 0, valid = true;
      for (const row of bucket.results) {
        if (!row || (id && row.project_id && row.project_id !== id)) { valid = false; break; }
        if (costs) {
          if (row.amount?.currency?.toLowerCase() !== 'usd' || count(row.amount.value) === null) { valid = false; break; }
          spend += row.amount.value;
          if (typeof row.project_name === 'string') reading.name = row.project_name;
        } else {
          if ([row.num_model_requests, row.input_tokens, row.output_tokens].some(value => count(value) === null || value < 0)) { valid = false; break; }
          requests += row.num_model_requests;
          tokens += row.input_tokens + row.output_tokens;
        }
      }
      if (valid && [spend, requests, tokens].every(value => count(value) !== null)) reading.days.set(start, costs ? { start, spend } : { start, requests, tokens });
    }
    reading.complete = body.has_more !== true;
    readings.set(key, reading);
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      // Only the request address and a response clone are read; page credentials stay with the page.
      const url = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url, 'https://platform.openai.com');
      if (url.origin === 'https://api.openai.com' && /^\/v1\/dashboard\/organization\/(costs|usage\/completions)$/.test(url.pathname) && url.searchParams.get('bucket_width') === '1d') {
        void capture(response, url).catch(() => {});
      }
    } catch (e) {}
    return response;
  };
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (node) => (node.innerText || '').trim();
  // The Usage page keeps its filters (source, project, keys, dates) as buttons in one form.
  const selector = () => {
    const nodes = [...document.querySelectorAll('form [role="button"], form button, [role="combobox"], button[aria-haspopup], button')];
    return nodes.find(node => /^all projects$/i.test(text(node)))
      || nodes.find(node => /project/i.test(node.getAttribute('aria-label') || ''))
      || nodes.find(node => node.closest && node.closest('form') && text(node) && !/^(all |last |[0-9]|api source)/i.test(text(node)));
  };
  const days = (reading) => reading ? [...reading.days.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(-31) : [];
  const result = () => {
    const selected = selector(), all = /^all projects$/i.test((selected?.innerText || '').trim());
    const costs = [...readings.values()].filter(row => row.costs && row.id && row.complete).pop();
    const usage = costs && readings.get(['usage', costs.id, costs.range].join('|'));
    const organization = [...readings.values()].filter(row => row.costs && !row.id && row.complete && (!costs || row.range === costs.range)).pop();
    let project = null;
    if (!all && costs && usage?.complete) {
      const merged = days(costs).filter(day => usage.days.has(day.start)).map(day => ({ ...day, ...usage.days.get(day.start) }));
      if (merged.length) project = { name: costs.name || (selected?.innerText || '').trim() || costs.id, id: costs.id, days: merged };
    }
    return { signedIn: true, project, organization: { days: days(organization) } };
  };
  const refresh = () => {
    const buttons = [...document.querySelectorAll('button')];
    const label = (node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText].join(' ');
    const dateButton = buttons.find(node => /date range|last [0-9]+ days/i.test(label(node)) || node.querySelector('svg[class*="calendar"]'));
    const next = dateButton?.nextElementSibling || dateButton?.parentElement?.nextElementSibling;
    const adjacent = next?.matches('button') ? next : next?.querySelector('button');
    const button = buttons.find(node => /refresh|reload/i.test(label(node)))
      || buttons.find(node => node.querySelector('svg[class*="refresh"], svg[class*="rotate"], [data-icon*="refresh"]'))
      || (adjacent?.querySelector('svg') && !(adjacent.innerText || '').trim() ? adjacent : null);
    if (button && !button.disabled) button.click();
  };
  const run = async () => {
    if (location.hostname !== 'platform.openai.com') { report({ signedIn: false, reason: 'signin' }); return; }
    while (challenged() && Date.now() < deadline) await wait(500);
    if (challenged()) { report({ signedIn: false, reason: 'challenge' }); return; }
    const signedOut = () => /\/(login|auth|signup)(\/|$)/.test(location.pathname)
      || /sign in|log in|create an account/i.test(document.body?.innerText || '');
    if (signedOut()) { report({ signedIn: false, reason: 'signin' }); return; }
    const retryAt = Math.min(deadline, Date.now() + 6000);
    let refreshed = false;
    while (Date.now() < deadline) {
      const value = result();
      if (value.project || /^all projects$/i.test((selector()?.innerText || '').trim())) {
        // The organization total is optional; give it a short moment to arrive, then report.
        const grace = Math.min(deadline, Date.now() + 2000);
        while (!result().organization.days.length && Date.now() < grace) await wait(250);
        await wait(250);
        report(result());
        return;
      }
      if (!refreshed && !value.project && Date.now() >= retryAt) { refresh(); refreshed = true; }
      await wait(250);
    }
    report(signedOut() ? { signedIn: false, reason: 'signin' } : result());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
