// The settings page's wording and the checks behind it, shared by the window app and the terminal app.
import { allPlugins, DEFAULT_REFRESH_SECONDS, type AlertKind, type AppConfig, type GenericProviderDef } from '@augur/core';

export const KIND_LABELS: Record<AlertKind, string> = {
  percent: 'Usage reaches a threshold',
  pace: 'Pace warning',
  reset: 'Limit spent with a reset in hand',
  balance: 'Balance is low',
  refresh: 'Refresh failed',
  models: 'New models to review',
  rules: 'Rule changes to accept',
  update: 'Update available',
};

export const ALERT_TEXT = {
  label: 'Alerts',
  master: 'Each alert fires once per window, then waits for the next reset. The grid below picks where each kind goes.',
  masterPhone: 'Each alert fires once per window, then waits for the next reset.',
  grid: 'Where each alert goes',
  gridHelp: 'Keep in Augur holds an alert under the bell until you dismiss it or it stops applying. Claude Code shows it in sessions with the Augur mod. Phone sends a push once push is on in the phone app.',
  keep: 'Keep in Augur',
  claude: 'Claude Code',
  phone: 'Phone',
  pct: 'Notify when a limit passes these percentages',
  burn: 'Burn-rate warning',
  burnHelp: 'Warns when usage left divided by time left in the window drops below this number. 1 means you run out right at the reset; 0.8 warns a bit earlier than that. Leave blank to turn one off.',
  session: 'Session',
  weekly: 'Weekly',
  other: 'Other',
  balances: 'Notify when a balance drops below',
};

export const CLAUDE_TEXT = {
  heading: 'Claude',
  code: 'Claude Code',
  codeDesc: 'Shows your usage in the status line and Augur alerts above the prompt, in the terminal and the Code tab. New sessions pick it up.',
  codeExport: 'Turning this on also saves your usage to .augur/usage.json, which the mod reads.',
  desktop: 'Claude Desktop chat',
  desktopDesc: 'Lets chats in Claude Desktop pick and run models through Augur. Restart Claude Desktop after turning this on or off.',
  desktopMissing: 'This build does not include the MCP server that Claude Desktop needs.',
};

export const STARTER_RULES_TEXT = 'Each provider starts with cautious rules that its models inherit: public data only, text output only, and named before use. A model cannot be used until you confirm it on the model rules page and allow the activities it needs.';

export const PROVIDER_TEXT = {
  heading: 'Providers',
  localLogin: (name: string) => `Reads the login of the ${name} command-line app on this computer. Sign in there first. No key is needed here.`,
  keySaved: 'Saved',
  keyReplace: 'Enter a new key to replace it',
  keyRemove: 'Remove',
  signedIn: 'Signed in',
  show: 'Show on the dashboard',
  refresh: 'Refresh every',
  refreshHelp: 'How often Augur reads this provider on its own. The refresh button reads every provider at once.',
  color: 'Color',
  colorDefault: 'Default',
};

export const REFRESH_CHOICES: ReadonlyArray<readonly [number, string]> = [[15, '15 seconds'], [300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [21600, '6 hours'], [86400, '1 day'], [604800, '1 week']];

/** A refresh interval in words, as the refresh choice lists it. */
export const refreshName = (sec: number): string => REFRESH_CHOICES.find(([s]) => s === sec)?.[1] ?? `${Math.round(sec / 60)} min`;

/** The label of the refresh choice that leaves a provider on its own default. */
export const refreshDefault = (own: number | undefined): string => `Default (${refreshName(own ?? DEFAULT_REFRESH_SECONDS)})`;

export const PHONE_TEXT = {
  heading: 'Phone',
  relay: 'Relay address',
  relayHelp: "Carries updates to your phone, locked with a key only your devices have. You can run your own relay from the project's source.",
  pwa: 'Web app address',
  pwaHelp: 'Where the phone opens Augur.',
  paired: 'Phone paired',
  pairedDesc: 'Each refresh sends an encrypted copy to your phone.',
  sync: 'Phone sync',
  syncDesc: 'Shows a code to scan with your phone. Needs both addresses above.',
  pair: 'Pair a phone',
  show: 'Show code',
  unpair: 'Unpair',
  shareKeys: 'Send API keys to the phone',
  shareKeysDesc: 'Lets the phone refresh key-based providers on its own by sending your API keys inside the encrypted sync. Off by default.',
  private: 'Anyone with the link can read everything the phone syncs, including your provider API keys if sending keys is on, so keep it private.',
};

export const COMPUTER_TEXT = {
  heading: 'This computer',
  version: (v: string) => `Version ${v}`,
  updates: 'Updates',
  check: 'Check for updates',
  status: { idle: '', checking: 'Checking for updates.', current: 'This is the latest version.', installing: 'Installing the update.', error: 'Could not check for updates. Try again later.' },
  available: (v: string) => `Version ${v} is available.`,
  managed: (by: string) => `${by} installed Augur, so it installs updates too: build the new package from the PKGBUILD attached to the new release and run makepkg -si.`,
  exportFile: 'Usage data file',
  exportFileDesc: 'The file other tools read for your usage and limits.',
  export: 'Also save the latest numbers to this file',
  exportHelp: 'After each refresh, Augur writes the latest numbers to this file in your home folder, so scripts and coding assistants can read them. Leave blank to turn this off.',
};

export const CUSTOM_TEXT = {
  heading: 'Custom providers',
  help: 'Track a provider that is not built in by pasting its definition as JSON: the address to call, how to send its key, and where each number sits in the answer. Once saved, it appears in the provider list above, where you add its key.',
  notList: 'Not a JSON list. Check the brackets and commas.',
  incomplete: 'Each definition needs id, name, auth and requests.',
  clash: (id: string) => `The id "${id}" is already used by a built-in provider.`,
};

export const CUSTOM_EXAMPLE = [
  {
    id: 'example',
    name: 'Example provider',
    color: { light: '#2a78d6', dark: '#3987e5' },
    links: { usage: 'https://example.com/billing' },
    auth: { type: 'bearer' },
    requests: { main: { url: 'https://api.example.com/v1/usage' } },
    meters: [
      { id: 'monthly', label: 'Monthly quota', usedPct: '=100 * main:$.used / main:$.limit', resetsAt: 'main:$.reset_at', resetsAtFormat: 'iso', windowSeconds: 2592000, windowKind: 'monthly' },
    ],
    money: [{ id: 'balance', label: 'Credits left', amount: 'main:$.balance', currency: 'USD' }],
  },
];

/** Checks pasted custom provider definitions: a JSON list, each with the required parts, none taking a built-in provider's id. */
export function parseCustom(text: string, config: AppConfig): { custom: GenericProviderDef[] } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!Array.isArray(parsed)) return { error: CUSTOM_TEXT.notList };
  const bad = parsed.find((d) => !d || typeof d.id !== 'string' || typeof d.name !== 'string' || !d.requests || !d.auth);
  if (bad) return { error: CUSTOM_TEXT.incomplete };
  const builtIn = allPlugins({ ...config, custom: [] });
  const clash = parsed.find((d) => builtIn.some((p) => p.id === d.id));
  if (clash) return { error: CUSTOM_TEXT.clash(clash.id) };
  return { custom: parsed as GenericProviderDef[] };
}

/** Reads the percentage list from its text box: numbers above 0 and up to 100, in order. */
export const parsePercents = (text: string): number[] => text.split(/[,\s]+/).map(Number).filter((n) => n > 0 && n <= 100).sort((x, y) => x - y);
