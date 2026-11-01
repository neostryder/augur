import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const cases = [
  'drag roundtrip', 'drop refusals', 'last removal', 'remove controls', 'restore recheck', 'search inputs', 'search Escape', 'mode swap', 'mode swap reduced', 'drag commit', 'drag cancel', 'click without movement', 'keyboard slider', 'range keyboard',
  'tab arrows', 'ring arrows', 'Escape', 'focus trap', 'long press', 'outside release',
  'cancel and blur', 'mouse hold', 'node selection', 'catalog tap', 'drag feedback',
  'add refusal', 'copy undo', 'suggest undo', 'Ctrl K drafts', 'Ctrl K drag', 'activity shortcuts',
  'tooltip scope', 'phone layout', 'phone focus', 'popup bounds', 'null level', 'blocked chips',
];
let server: ViteDevServer, child: ChildProcess, profile: string, sessionId: string, sequence = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
function command(method: string, params: unknown = {}, session?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    (child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }) + '\0');
  });
}

beforeAll(async () => {
  const executable = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
  if (!executable) throw new Error('The element tests require Chrome or Chromium (CHROME_PATH).');
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, clearScreen: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'element-fixture', configureServer(vite) {
    vite.middlewares.use((req, res, next) => { if (req.url !== '/__node-test') return next(); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body></body></html>'); });
  } }] });
  await server.listen();
  profile = mkdtempSync(join(tmpdir(), 'augur-node-element-'));
  child = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-pipe', `--user-data-dir=${profile}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let buffer = '';
  (child.stdio[4] as NodeJS.ReadableStream).on('data', chunk => {
    buffer += String(chunk); let end: number;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const call = pending.get(message.id); if (!call) continue; pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    }
  });
  child.on('error', error => { for (const call of pending.values()) call.reject(error); pending.clear(); });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }));
  await command('Page.enable', {}, sessionId);
  await command('Page.navigate', { url: server.resolvedUrls!.local[0] + '__node-test' }, sessionId);
  await command('Runtime.evaluate', { expression: "new Promise(resolve => { if (document.readyState === 'complete') resolve(); else addEventListener('load', resolve, { once: true }); })", awaitPromise: true }, sessionId);
}, 60000);

afterAll(async () => {
  if (child) { await command('Browser.close').catch(() => undefined); if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve)); }
  await server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('node element and app wiring in Chromium', () => {
  it('drags a slice to the list with native mouse input', async () => {
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
    const result = await command('Runtime.evaluate', { expression: "import('/test/node-element.browser.ts').then(module => module.prepareNativeDrag())", awaitPromise: true, returnByValue: true }, sessionId);
    expect(result.exceptionDetails).toBeUndefined();
    const { from, to } = result.result.value;
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from }, sessionId);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...from }, sessionId);
    for (let step = 1; step <= 12; step++) await command('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 }, sessionId);
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...to }, sessionId);
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...to }, sessionId);
    const checked = await command('Runtime.evaluate', { expression: "import('/test/node-element.browser.ts').then(module => module.checkNativeDrag())", awaitPromise: true, returnByValue: true }, sessionId);
    expect(checked.exceptionDetails?.exception?.description ?? checked.exceptionDetails?.text).toBeUndefined();
  }, 30000);
  it.each(cases)('%s', async name => {
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: name.endsWith(' reduced') ? 'reduce' : 'no-preference' }] }, sessionId);
    await command('Emulation.setDeviceMetricsOverride', { width: name.startsWith('phone') || name === 'focus trap' || name === 'popup bounds' ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const caseName = name.replace(/ reduced$/, '');
    const result = await command('Runtime.evaluate', { expression: `import('/test/node-element.browser.ts').then(module => module.run(${JSON.stringify(caseName)}))`, awaitPromise: true, returnByValue: true }, sessionId);
    expect(result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text).toBeUndefined();
    expect(result.result.value).toBe(caseName);
  }, 30000);
});
