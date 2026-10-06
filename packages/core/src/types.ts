// Shared contract between the provider plugins, the desktop shell, the PWA and the UI.

import type { OutletConfig } from './feed.js';
import type { PolicyConfig } from './policy.js';

export type WindowKind = 'session' | 'daily' | 'weekly' | 'monthly' | 'credits' | 'other';

export interface Meter {
  id: string;
  label: string;
  /** 0 to 100, or null when the provider reports no percentage. */
  usedPct: number | null;
  /** ISO 8601 time the window resets. */
  resetsAt?: string | null;
  /** Length of the window, used for pace and burn-rate alerts. */
  windowSeconds?: number | null;
  windowKind?: WindowKind;
  detail?: string | null;
  active?: boolean | null;
}

export interface Money {
  id: string;
  label: string;
  amount: number | null;
  currency: string;
  /** Set when the amount is part of a known total, such as credits bought. */
  total?: number | null;
  detail?: string | null;
}

export type StatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown';

export interface ProviderStatus {
  indicator: StatusIndicator;
  description?: string;
  url?: string;
}

/** What a plugin's fetch returns. The engine adds the bookkeeping fields. */
export interface ProviderResult {
  plan?: string | null;
  /** Short provider summary, used for health tiles without meters. */
  detail?: string | null;
  meters: Meter[];
  money: Money[];
  notes?: Record<string, unknown>;
  /** The provider's own response, kept for debugging. Never include credentials. */
  raw?: unknown;
}

export interface ProviderSnapshot extends ProviderResult {
  id: string;
  name: string;
  ok: boolean;
  /** True when the last fetch failed and the data is carried over from an earlier one. */
  stale: boolean;
  fetchedAt: string | null;
  /** When the last read was tried, successful or not. */
  attemptedAt?: string | null;
  error: string | null;
  links?: ProviderLinks;
  status?: ProviderStatus | null;
}

export interface Snapshot {
  schema: 1;
  generatedAt: string;
  providers: Record<string, ProviderSnapshot>;
}

// ------------------------------------------------------------------ host

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Platform = 'windows' | 'macos' | 'linux' | 'browser';

/**
 * Everything a plugin may do outside plain computation. Each shell supplies its own:
 * the desktop app routes these through Rust commands, the PWA through a proxy,
 * and the Node runner through fetch, fs and child_process.
 * Optional members are absent where the platform cannot offer them (the browser has no files).
 */
export interface Host {
  platform: Platform;
  http(req: HttpRequest): Promise<HttpResponse>;
  /** A secret the user entered in setup, looked up by the field's secret name. */
  secret(name: string): Promise<string | null>;
  /** Paths are relative to the user's home directory, with forward slashes. */
  readHomeFile?(path: string): Promise<string | null>;
  writeHomeFileAtomic?(path: string, text: string): Promise<void>;
  /** Only commands on the shell's allowlist run; anything else rejects. */
  run?(command: string, args: string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Generic-password items in the OS keychain (macOS stores the Claude Code login there). */
  keychainGet?(service: string, account?: string): Promise<string | null>;
  keychainSet?(service: string, account: string, value: string): Promise<void>;
  /** Reads Copilot usage for the GitHub CLI's signed-in account without handing the caller its token. Desktop only; other shells fall back to run. */
  copilotUsage?(): Promise<HttpResponse>;
  /** Reads an account page through a browser session the shell keeps signed in, for providers with no usage API. Resolves to null when there is no session. */
  webSession?(site: string, options?: { fresh?: boolean }): Promise<Record<string, unknown> | null>;
  now?(): Date;
  /** Optional environment lookup for local login paths and account names. */
  env?(name: string): string | null;
  log?(message: string): void;
}

// ------------------------------------------------------------------ plugins

export interface FieldSpec {
  key: string;
  label: string;
  kind: 'secret' | 'text' | 'toggle' | 'select' | 'signin';
  /** For a signin field, the site the shell opens a sign-in window for. */
  site?: string;
  required?: boolean;
  help?: string;
  options?: string[];
  placeholder?: string;
}

export interface ProviderLinks {
  /** The provider's own usage or billing page. */
  usage?: string;
  /** Human status page. */
  status?: string;
  /** Statuspage-style JSON endpoint (`/api/v2/status.json`). */
  statusApi?: string;
  /** Names of the status page components this provider depends on. When set, the badge follows the worst of them instead of the whole page, so an incident in an unrelated product does not show. */
  statusComponents?: string[];
}

export interface ProviderPlugin {
  id: string;
  name: string;
  /** Categorical identity color for light and dark themes. */
  color?: { light: string; dark: string };
  links: ProviderLinks;
  /** Needs a CLI login on this computer, so it cannot run from the PWA alone. */
  needsLocalLogin: boolean;
  fields: FieldSpec[];
  /** First-run setup calls this to preselect providers already signed in on this computer. */
  detect?(host: Host): Promise<boolean>;
  /** `force` is set when the reading was asked for, so a provider that keeps a slow cache of its own should skip it. */
  fetch(host: Host, settings: ProviderSettings, options?: { force?: boolean }): Promise<ProviderResult>;
  /** Default refresh interval in seconds, for providers that should be read less often than the app-wide interval. */
  refreshSeconds?: number;
  /** The models this account can use, for the rules page. */
  listModels?(host: Host, settings: ProviderSettings): Promise<Array<{ id: string; name?: string; created?: string }>>;
  /** `auto` adds each new listed model for review; `catalog` keeps the list to pick from, for marketplaces with hundreds of models. Defaults to auto. */
  modelListMode?: 'auto' | 'catalog';
  /** First part of a model's route label, such as xai for Grok. Defaults to the provider id. */
  labelPrefix?: string;
}

export type ProviderSettings = Record<string, string | boolean | undefined>;

// ------------------------------------------------------------------ config

export interface ProviderConfig {
  id: string;
  enabled: boolean;
  /** Non-secret settings. Secret values live in the keychain, keyed `<providerId>.<fieldKey>`. */
  settings: ProviderSettings;
  /** How often this provider refreshes, in seconds. Unset uses the provider's own default, then DEFAULT_REFRESH_SECONDS. */
  refreshSeconds?: number | null;
}

export interface AlertConfig {
  enabled: boolean;
  /** Notify when a meter first crosses each of these percentages. */
  pctThresholds: number[];
  /**
   * Burn-rate alert: notify when (remaining usage fraction) / (remaining time fraction)
   * drops below this ratio. 1.0 means on pace to run out exactly at reset.
   */
  paceRatio: { session: number | null; weekly: number | null; other: number | null };
  /** Notify when a balance, keyed `<providerId>.<moneyId>`, drops below the amount. */
  balanceBelow: Record<string, number>;
  /** Where each kind of alert goes: the computer's notifications, the bell, the Claude Code mod and the paired phone. */
  outlets: OutletConfig;
}

export interface LayoutConfig {
  theme: 'system' | 'light' | 'dark';
  columns: 'auto' | 1 | 2;
  /** Meter ids hidden per provider. */
  hiddenMeters: Record<string, string[]>;
  collapsed: string[];
}

export interface AppConfig {
  schema: 1;
  /** Array order is display order. */
  providers: ProviderConfig[];
  custom: GenericProviderDef[];
  layout: LayoutConfig;
  alerts: AlertConfig;
  /** Where the desktop app writes the latest snapshot for other tools to read, relative to home. */
  exportPath?: string | null;
  /** Desktop global shortcut that opens and closes the panel, such as Ctrl+Super+U. Null turns it off. */
  hotkey?: string | null;
  /** Install new desktop releases without asking. Defaults to on. */
  autoUpdate?: boolean;
  /** Desktop: open the panel on the main usage view whenever the app starts. Defaults to on. */
  openOnLaunch?: boolean;
  /** Desktop-to-phone sync channel. The encryption key and write secret live in the keychain. */
  /** shareKeys: send key-based providers' API keys to the paired phone, inside the encrypted sync. Defaults to off. */
  sync?: { relay: string; channel: string; pwaUrl: string; shareKeys?: boolean } | null;
  /**
   * Fallback for secrets missing from the keychain: read them from a Bitwarden Secrets Manager
   * project with the `bws` CLI, mapped from `<providerId>.<fieldKey>` to the secret's key there.
   */
  secretSources?: { bws?: { projectId: string; map: Record<string, string> } } | null;
  /** Usage rules per provider and model, written to policy.json beside the export. */
  policy?: PolicyConfig;
  /** Windows desktop: whether the app also runs the dispatch service for agents. Off means usage tracking and rules only. */
  dispatch?: { runJobs: boolean };
  /** How much of what an agent asks to change in the rules waits for the owner: `all`, `risky` (the default) or `none`. Only the app and the terminal change it. */
  agentApproval?: 'all' | 'risky' | 'none';
}

// ------------------------------------------------------------------ declarative providers

/**
 * A provider defined entirely in config: one or more JSON requests, and paths into the
 * responses that become meters and money. Enough for any API-key provider whose usage
 * endpoint returns plain JSON. Providers that need an OAuth refresh or a CLI login are
 * written as code plugins instead.
 *
 * Value expressions: `req:path` reads a value, where `req` names a request and `path` is
 * `$.a.b[0].c` with an optional `[key=value]` filter step, for example
 * `main:$.model_remains[model_name=general].current_weekly_remaining_percent`.
 * Prefix with `=` for arithmetic over several reads: `=100 - main:$.remaining`.
 */
export interface GenericProviderDef {
  id: string;
  name: string;
  color?: { light: string; dark: string };
  links?: ProviderLinks;
  auth: {
    type: 'bearer' | 'header' | 'query' | 'none';
    /** Header name for `header`, query parameter name for `query`. */
    name?: string;
    /** Prefix placed before the secret, such as `Key ` for fal. */
    prefix?: string;
  };
  requests: Record<string, { url: string; method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> }>;
  plan?: string;
  meters?: Array<{
    id: string;
    label: string;
    usedPct?: string;
    resetsAt?: string;
    resetsAtFormat?: 'iso' | 'epoch_s' | 'epoch_ms';
    windowSeconds?: number;
    windowKind?: WindowKind;
    /** Value path or template with `{req:$.path}` and optional `|fixed2`. */
    detail?: string;
    /** Emit this meter only when the expression resolves to a nonzero value. */
    includeIf?: string;
  }>;
  money?: Array<{ id: string; label: string; amount: string; total?: string; currency?: string }>;
}
