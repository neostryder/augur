// Draws the tray icon: a ring filled to the most-used limit with the percent inside, in the
// same status colors as the meters. Rendered here so Windows and macOS share one design.

export function renderTrayIcon(pct: number | null, size: number, lightTaskbar: boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const ink = lightTaskbar ? '#141414' : '#ffffff';
  const stroke = Math.max(2, size / 9);
  const r = size / 2 - stroke / 2 - 0.5;
  const cx = size / 2, cy = size / 2;

  g.lineWidth = stroke;
  g.strokeStyle = lightTaskbar ? 'rgba(20,20,20,0.24)' : 'rgba(255,255,255,0.32)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();

  let text = '?';
  if (pct != null) {
    g.strokeStyle = pct >= 90 ? '#e66767' : pct >= 75 ? '#fab219' : '#3987e5';
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, Math.max(1, pct))) / 100);
    g.stroke();
    text = pct >= 99.5 ? '!' : String(Math.round(pct));
  }
  g.fillStyle = ink;
  g.font = `700 ${Math.round(size * (text.length >= 2 ? 0.44 : 0.52))}px "Segoe UI", -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy + size * 0.03);
  return canvas.toDataURL('image/png').split(',')[1]!;
}
