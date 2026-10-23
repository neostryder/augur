// The chat face's wire types: the model list the picker draws from, the settings each model offers, saved chats, and the events a reply streams.
// The settings shape is the one Cogitator's capabilities document uses, so one settings panel serves a local model and a hosted one.
import type { DataTier } from '@augur/core';

export type ChatSettingType = 'number' | 'integer' | 'boolean' | 'text' | 'text_list' | 'choice';

export interface ChatSettingDef {
  key: string;
  label: string;
  type: ChatSettingType;
  /** What the model does when the setting is left alone. Shown as the placeholder, and never sent. */
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  max_items?: number;
  choices?: string[];
  /** Rare settings sit under Advanced. */
  advanced?: boolean;
  /** One plain-language sentence or two: what the control does and what moving it feels like. */
  tooltip: string;
  /** How the value reaches the request when the key is not the field name: `messages[system]`, or a dotted path such as `chat_template_kwargs.enable_thinking`. */
  via?: string;
}

export type ChatShape = 'openai' | 'anthropic';

export interface ChatModelInfo {
  /** The route name, which is what a chat stores and a send names. */
  route: string;
  /** What the picker shows. */
  label: string;
  /** The `<provider>/<model>` label policy.json knows the route by. */
  model: string;
  shape: ChatShape;
  /** The model takes image attachments. */
  vision: boolean;
  /** The model runs on this computer or on the home network. */
  local: boolean;
  /** The most sensitive data the rules let this model see, or null when the rules do not know it. */
  tierMax: DataTier | null;
  /** False when the rules refuse the model outright (unreviewed, paused, unknown). */
  usable: boolean;
  /** Why it is not usable, or a caution. */
  why?: string;
  contextTokens?: number;
  settings: ChatSettingDef[];
}

export type ChatFileKind = 'image' | 'audio' | 'text' | 'file';
export interface ChatFileRef { id: string; name: string; mime: string; bytes: number; kind: ChatFileKind }

export type ChatMessageState = 'done' | 'streaming' | 'error' | 'stopped';
export interface ChatMessage {
  id: string;
  /** The message this one answers or follows. Siblings share a parent, which is how an edit or a regenerate keeps the old branch. */
  parent: string | null;
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  files: ChatFileRef[];
  /** The route that wrote an assistant message. */
  route?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  served?: Record<string, string>;
  state: ChatMessageState;
  error?: string;
  at: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  route: string;
  tier: DataTier;
  pinned: boolean;
  /** A temporary chat lives in the service's memory only and is gone when it is closed or the service restarts. */
  temporary: boolean;
  createdAt: number;
  updatedAt: number;
  messages: number;
  /** The first words of the last message, for the list. */
  preview: string;
}

export interface ChatDetail extends ChatSummary {
  system: string;
  /** Only the settings the person set. Anything left out is the model's own default. */
  settings: Record<string, unknown>;
  /** The newest message on the branch being read. */
  head: string | null;
  /** Every message of every branch, oldest first. The client walks parents from `head`. */
  tree: ChatMessage[];
}

/** One line of the stream a send answers with. */
export type ChatEvent =
  | { t: 'start'; user: ChatMessage; assistant: ChatMessage }
  | { t: 'delta'; text: string }
  | { t: 'think'; text: string }
  | { t: 'file'; file: ChatFileRef }
  | { t: 'usage'; usage: NonNullable<ChatMessage['usage']> }
  | { t: 'title'; title: string }
  | { t: 'done'; message: ChatMessage }
  | { t: 'error'; message: string };

export interface ChatSendParams {
  chat: string;
  text: string;
  /** Files already uploaded with `chat.upload`. */
  files?: string[];
  /** Where the new user message hangs. Omitted means the chat's head. Naming an earlier message is an edit or a branch. */
  parent?: string | null;
  /** A regenerate: answer this existing user message again instead of adding a new one. */
  retry?: string;
  /** Answer with this route for this message only. */
  route?: string;
}

export const CHAT_TITLE_MAX = 80;
export const CHAT_FILE_MAX_MB = 25;
