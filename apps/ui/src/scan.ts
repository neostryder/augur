// Reads a QR code with the phone's camera. Uses the browser's own barcode reader where there is
// one and falls back to jsQR (loaded only when needed), since iPhone Safari has no BarcodeDetector.

interface Detector { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }

/** Opens a full-screen camera view and resolves with the first QR code's text, or null on Cancel. */
export async function scanQr(): Promise<string | null> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device has no camera Augur can use.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    const name = (err as DOMException)?.name;
    throw new Error(name === 'NotAllowedError' || name === 'SecurityError'
      ? "Camera access is blocked. Allow the camera for Augur in the phone's settings, then try again."
      : 'This device has no camera Augur can use.');
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Scan pairing code');
  overlay.innerHTML = `<video playsinline muted></video><div class="frame"></div>
    <p>Point the camera at the pairing code on your desktop.</p><button class="btn">Cancel</button>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('video')!;
  video.srcObject = stream;
  await video.play().catch(() => undefined);

  const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  const detector = Native ? new Native({ formats: ['qr_code'] }) : null;
  const jsQR = detector ? null : (await import('jsqr')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector('button')!.addEventListener('click', () => finish(null));
    const tick = async () => {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          if (detector) {
            const found = await detector.detect(video);
            if (found[0]?.rawValue) return finish(found[0].rawValue);
          } else if (jsQR) {
            const w = Math.min(960, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) return finish(code.data);
          }
        } catch { /* keep trying on the next frame */ }
      }
      requestAnimationFrame(() => void tick());
    };
    void tick();
  });
}
