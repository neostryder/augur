// The longer user-facing text of the chat, kept in one place so it can be written and reviewed as a set.
import type { DataTier } from '@augur/core';

export const TIER_COPY: Record<DataTier, { name: string; blurb: string }> = {
  public: { name: 'Public', blurb: 'Anything you would be fine posting openly. Every model that is switched on can take it.' },
  internal: { name: 'Internal', blurb: 'Everyday personal or work text. Models you have cleared for internal use can take it.' },
  sensitive: { name: 'Sensitive', blurb: 'Private details about people, accounts, or plans. Only models cleared for sensitive data can take it.' },
  regulated: { name: 'Regulated', blurb: 'Records covered by rules or contracts, such as student or health data. Only models cleared for regulated data, usually ones that run here, can take it.' },
};

export const TIER_LOCKED = 'A chat that already has messages cannot go to a lower level, because what it holds has already been sent to a model.';

export const EMPTY = {
  title: 'What shall we work on?',
  lead: 'Pick a model and start typing. Models that run on your own network are listed first, and a chat is only ever offered to models the rules allow for its data level.',
  hints: 'Drop files or paste images to attach them. Press Ctrl+K for everything else.',
  noModels: 'No chat models are set up yet. Add an OpenAI-style or Anthropic-style route in Augur and it will appear here.',
};

export const TEMP_NOTE = 'Temporary chat: kept in memory only and gone when you close it or the service restarts.';

export const GATE = 'Paste the web token from Augur to open the chat. It stays in this browser only.';

export const PREF_TIPS = {
  motion: 'Slides, fades and the typing cursor. Turn them off if you prefer a still page.',
  compact: 'Tighter spacing, so more of a long conversation fits on screen.',
  thinking: 'Show a model\'s reasoning expanded as it arrives. It is always available behind a click.',
};

export const SETTINGS_NOTE = 'Only values you change are sent. Anything you leave alone keeps the model\'s own default.';
