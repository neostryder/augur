// The longer user-facing text of the chat, kept in one place so it can be written and reviewed as a set.
import type { DataTier } from '@augur/core';

export const TIER_COPY: Record<DataTier, { name: string; blurb: string }> = {
  public: { name: 'Public', blurb: 'Anything you would be happy to post in public. Every model you have switched on can take it.' },
  internal: { name: 'Internal', blurb: 'Ordinary work or personal text that is not secret, like drafts and notes. Your rules decide which models get it.' },
  sensitive: { name: 'Sensitive', blurb: 'Names, accounts, money, or plans you would not want leaked. Only models your rules trust with sensitive data can take it.' },
  regulated: { name: 'Regulated', blurb: 'Student, health, or other records that a law or a contract protects. Few models are allowed this level, usually ones that run on your own network.' },
};

export const TIER_LOCKED = 'This chat already has messages, so its level cannot go lower. Its history goes to whichever model answers next.';

export const EMPTY = {
  title: 'Start a new chat',
  lead: 'Choose a model and a data level with the chips under the message box, then type. Models on your own network come first, and a model the rules have not cleared for this level cannot be picked.',
  hints: 'Drop or paste files to attach them, and press Ctrl+K for every other command.',
  noModels: 'No chat models are set up yet. Add an OpenAI-style or Anthropic-style API route in Augur, and it shows up here.',
};

export const TEMP_NOTE = 'Temporary chat: held in the service\'s memory and never saved. Deleting it or restarting the service ends it for good.';

export const GATE = 'Paste the web token to open the chat. The augur web command prints it, and only this browser keeps it.';

export const PREF_TIPS = {
  motion: 'Slide and fade effects, plus the typing cursor in a reply that is still arriving.',
  compact: 'Less space between messages, so more of a long chat fits on the screen.',
  thinking: 'Keeps a model\'s reasoning open as it arrives. With this off, the reasoning folds away once the reply starts, one click from view.',
};

export const SETTINGS_NOTE = 'Only the values you change are sent. Everything else stays at the model\'s own default.';
