// Runs on each page load in the hidden TypeSafe reader window. A Cloudflare check that passes on its own
// loads the billing page, where the script runs again. When the numbers are missing, `reason` says what
// was on screen instead: a Cloudflare check that did not pass, a sign-in page, or a billing page without
// a balance, which also carries the page's headings so a changed layout can be matched again.
//
// TypeSafe has renamed its labels before ("Credit Balance" became "Available credits"), so an amount is
// matched by the words around it rather than by one exact label.
(() => {
  if (window.top !== window) return;
  const report = (payload) => { location.href = 'https://augur.invalid/report?data=' + encodeURIComponent(JSON.stringify(payload)); };
  const challenged = () => /just a moment|attention required/i.test(document.title)
    || !!document.querySelector('#challenge-form, #challenge-running, #challenge-stage, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
  const signInPage = () => !!document.querySelector('input[type=password], input[type=email]') || /sign[-_]?in|log[-_]?in|auth/i.test(location.pathname);

  const BALANCE_WORDS = /balance|credits?|available|remaining|funds/i;
  const SPEND_WORDS = /spen[dt]|last 7 days|past 7 days|this week/i;
  // Keeps "Refills to $20.00 when below $5.00" and invoice or spending rows from being read as the balance.
  const NOT_A_TOTAL = /refill|recharge|top.?up|below|under|invoice|paid|charged|price|per /i;

  // "Credit Balance $12.50" and "Available credits" above "$38.06" both match: the label is the amount's own line, or the line above when the amount sits alone.
  const amountNear = (text, words, avoid) => {
    for (const m of text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)) {
      const start = text.lastIndexOf('\n', m.index - 1) + 1;
      const sameLine = text.slice(start, m.index);
      const lineAbove = text.slice(text.lastIndexOf('\n', start - 2) + 1, Math.max(start - 1, 0));
      const label = sameLine.trim() ? sameLine : lineAbove;
      if (words.test(label) && !avoid.test(label)) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  };
  const balanceOf = (text) => amountNear(text, BALANCE_WORDS, new RegExp(NOT_A_TOTAL.source + '|' + SPEND_WORDS.source, 'i'));

  const run = async () => {
    if (location.hostname !== 'console.typesafe.ai') { report({ signedIn: false, reason: 'signin' }); return; }
    let text = '', challenge = false, balance = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      challenge = challenged();
      text = document.body ? document.body.innerText : '';
      balance = challenge ? null : balanceOf(text);
      if (balance != null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (challenge) { report({ signedIn: false, reason: 'challenge' }); return; }
    if (balance == null) {
      if (signInPage()) { report({ signedIn: false, reason: 'signin' }); return; }
      const headings = [...document.querySelectorAll('h1, h2, h3')].map((h) => h.innerText.trim().slice(0, 60)).filter(Boolean).slice(0, 12);
      report({ signedIn: false, reason: 'nobalance', diag: { path: location.pathname, headings, amounts: (text.match(/\$\s?[\d,]+/g) || []).length } });
      return;
    }
    let usage = null;
    try { const r = await fetch('/api/usage?granularity=day'); if (r.ok) usage = await r.json(); } catch (e) {}
    const refill = (text.match(/[^\n]*\b(?:refill|recharge|top.?up)[^\n]*\$[\d.,]+[^\n]*\$[\d.,]+[^\n]*/i) || [null])[0];
    report({ signedIn: true, balance, spend7d: amountNear(text, SPEND_WORDS, NOT_A_TOTAL), refill: refill && refill.trim(), usage });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
