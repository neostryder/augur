// The colors the terminal app draws with. They match the window app's, and fall back to the terminal's own palette where it has no
// true color. A terminal cannot report its background, so the dark variants are used unless the theme setting says light.
import { allPlugins, type AppConfig } from '@augur/core';
import type { Color, Style } from '@augur/terminal';

export interface Theme {
  dark: boolean;
  accent: Style;
  good: Style;
  warn: Style;
  crit: Style;
  muted: Style;
  heading: Style;
  /** The selected row's highlight. */
  selected: Style;
  provider(id: string): Style;
}

const hex = (c: string): Color | undefined => (/^#[0-9a-f]{6}$/i.test(c) ? (c as Color) : undefined);

export function themeFor(config: AppConfig): Theme {
  const dark = config.layout.theme !== 'light';
  const colors = new Map(allPlugins(config).map((p) => [p.id, p.color]));
  return {
    dark,
    accent: { fg: dark ? '#3987e5' : '#2a78d6' },
    good: { fg: '#0ca30c' },
    warn: { fg: '#fab219' },
    crit: { fg: dark ? '#e66767' : '#d03b3b' },
    muted: { dim: true },
    heading: { bold: true },
    selected: { inverse: true },
    provider(id) {
      const custom = config.providers.find((p) => p.id === id)?.settings?.color;
      const c = typeof custom === 'string' && custom ? custom : (dark ? colors.get(id)?.dark : colors.get(id)?.light) ?? '';
      const fg = hex(c);
      return fg ? { fg } : { dim: true };
    },
  };
}

/** The style for a severity from the view model or an alert: '' or 'info' for normal, 'warn' or 'crit'. */
export function sevStyle(theme: Theme, sev: '' | 'warn' | 'crit' | 'info'): Style {
  return sev === 'crit' ? theme.crit : sev === 'warn' ? theme.warn : theme.accent;
}
