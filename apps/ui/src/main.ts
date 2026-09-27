import './styles.css';
import { App } from './app';
import { pickShell } from './shells';

const shell = await pickShell();
await new App(shell, document.getElementById('app')!, document.getElementById('tip')!).start();

if (shell.kind === 'pwa' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('./sw.js');
  // A home-screen app often resumes from memory instead of reloading, so on returning to the
  // foreground it compares its own script with the one the server now serves.
  const mine = [...document.scripts].map((s) => s.src).find((src) => /\/assets\/index-[^/]+\.js$/.test(src));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !mine) return;
    const html = await fetch('./', { cache: 'no-store' }).then((r) => r.text()).catch(() => '');
    const live = html.match(/assets\/index-[^"']+\.js/)?.[0];
    if (live && !mine.endsWith(live)) location.reload();
  });
}
