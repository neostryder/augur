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
    prompt: 'You can open chat with the owner\'s web token or the personal token the owner gave you. This browser keeps the token.',
    token: 'Your token',
    open: 'Open',
    rejected: 'The token was not accepted.',
    unregistered: 'Your sign-in succeeded, but the owner has not set up your access to Augur Chat. Please ask the owner for access.',
    unavailable: 'The chat service could not be reached. Please reload this page to try again.',
  },
  SESSION: {
    owner: 'Owner',
    signOut: 'Sign out',
    noModels: 'The owner has not given you any models yet. Please ask the owner to add models to your account.',
  },
  ADMIN: {
    title: 'Manage users',
    close: 'Close',
    loading: 'The users are loading.',
    empty: 'You have not added any users yet.',
    addUser: 'Add user',
    id: 'User id',
    name: 'Name',
    email: 'Email (optional)',
    enabled: 'The user is enabled.',
    tierCap: 'Maximum data level',
    dailyMessages: 'Daily message limit',
    unlimited: 'The user has no daily limit when this field is empty.',
    models: 'Allowed models',
    noRoutes: 'You have no chat routes yet.',
    refused: 'The rules refuse this route.',
    devices: 'Devices',
    noDevices: 'The user has no devices yet.',
    revoke: 'Revoke',
    revoked: 'The device is revoked.',
    addDevice: 'Add device',
    deviceLabel: 'Device label',
    newToken: 'New token',
    rotateConfirm: 'The old personal token will stop working. Do you want to create a new token?',
    deleteUser: 'Delete user',
    deleteConfirm: 'The user and their tokens will be deleted. Do you want to continue?',
    purge: 'You also want to delete their chats.',
    confirm: 'Confirm',
    cancel: 'Cancel',
    token: 'New token',
    tokenOnce: 'This token is shown once. Please copy it now because it is not shown again.',
    copy: 'Copy',
    copied: 'The token was copied.',
    copyFailed: 'The token could not be copied. Please select and copy it from the box.',
    saving: 'The changes are saving.',
    saved: 'The changes were saved.',
    error: 'The change could not be saved.',
  },
};

export const PREF_TIPS = {
  motion: 'Slide and fade effects, plus the typing cursor in a reply that is still arriving.',
  compact: 'Less space between messages, so more of a long chat fits on the screen.',
  thinking: 'Keeps a model\'s reasoning open as it arrives. With this off, the reasoning folds away once the reply starts, one click from view.',
};

export const SETTINGS_NOTE = 'Only the values you change are sent. Everything else stays at the model\'s own default.';
