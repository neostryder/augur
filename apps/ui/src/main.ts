import './styles.css';
import { App } from './app';
import { pickShell } from './shells';

const shell = await pickShell();
await new App(shell, document.getElementById('app')!, document.getElementById('tip')!).start();

if (shell.kind === 'pwa' && 'serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register('./sw.js');
}
