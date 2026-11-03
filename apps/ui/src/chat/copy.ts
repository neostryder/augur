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

export const MULTI_USER = {
  GATE: {
    title: 'Augur Chat',
    prompt: 'Enter the personal token the owner gave you, or the owner web token. Only this browser keeps the token.',
    token: 'Your token',
    open: 'Open chat',
    rejected: 'This token was not accepted. Check it and try again, or ask the owner for a new one.',
    unregistered: 'You are signed in, but you are not set up for Augur Chat. Ask the owner for access.',
    unavailable: 'The chat service could not be reached, so sign-in is not possible. Reload the page to try again.',
  },
  SESSION: {
    owner: 'Owner',
    signOut: 'Sign out',
    noModels: 'You have no models yet. Ask the owner to add models to your account.',
  },
  ADMIN: {
    title: 'Manage users',
    close: 'Close',
    loading: 'Loading users...',
    empty: 'There are no users yet. Add a user to give someone access to chat.',
    addUser: 'Add user',
    id: 'User id',
    name: 'Name',
    email: 'Email (optional)',
    enabled: 'Enabled',
    tierCap: 'Maximum data level',
    dailyMessages: 'Daily message limit',
    unlimited: 'Leave empty for no limit.',
    models: 'Allowed models',
    noRoutes: 'There are no chat routes to allow yet.',
    refused: 'Blocked by the rules',
    devices: 'Devices',
    noDevices: 'No devices yet',
    revoke: 'Revoke',
    revoked: 'Revoked',
    addDevice: 'Add device',
    deviceLabel: 'Device label',
    newToken: 'New token',
    rotateConfirm: 'Creating a new token for this user stops the old personal token from working.',
    deleteUser: 'Delete user',
    deleteConfirm: 'Deleting this user also deletes their tokens. Their chats and files stay unless you check the box.',
    purge: 'Also delete their chats and files',
    confirm: 'Confirm',
    cancel: 'Cancel',
    token: 'New token',
    tokenOnce: 'Copy this token now. It is not shown again.',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'The token could not be copied. Select it in the box and copy it by hand.',
    saving: 'Saving...',
    saved: 'Saved',
    error: 'The change was not saved. Make the change again to retry.',
  },
};

export const PREF_TIPS = {
  motion: 'Slide and fade effects, plus the typing cursor in a reply that is still arriving.',
  compact: 'Less space between messages, so more of a long chat fits on the screen.',
  thinking: 'Keeps a model\'s reasoning open as it arrives. With this off, the reasoning folds away once the reply starts, one click from view.',
};

export const SETTINGS_NOTE = 'Only the values you change are sent. Everything else stays at the model\'s own default.';
