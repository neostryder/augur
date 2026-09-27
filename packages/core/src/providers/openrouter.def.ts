import type { GenericProviderDef } from '../types.js';

export const openrouterDef: GenericProviderDef = {
  id: 'openrouter', color: { light: '#2a78d6', dark: '#3987e5' }, name: 'OpenRouter',
  links: { usage: 'https://openrouter.ai/settings/credits', status: 'https://status.openrouter.ai/' },
  auth: { type: 'bearer' },
  requests: {
    credits: { url: 'https://openrouter.ai/api/v1/credits' },
    key: { url: 'https://openrouter.ai/api/v1/key' }
  },
  plan: 'Pay as you go',
  meters: [
    // Credits bought are not a cap, so a percentage meter appears only when the key has its own spending limit in key.limit.
    { id: 'key_limit', label: 'Key spending limit', usedPct: '=key:$.data.usage / key:$.data.limit * 100', includeIf: 'key:$.data.limit', windowKind: 'credits', detail: '${key:$.data.usage|fixed2} of ${key:$.data.limit|fixed2}' },
    { id: 'free_daily', label: 'Free-model requests today', usedPct: '=key:$.data.free_model_daily_requests.used / key:$.data.free_model_daily_requests.limit * 100', includeIf: 'key:$.data.free_model_daily_requests.limit', windowSeconds: 86400, windowKind: 'daily', detail: '{key:$.data.free_model_daily_requests.used} of {key:$.data.free_model_daily_requests.limit}' }
  ],
  money: [
    { id: 'balance', label: 'Credits left', amount: '=credits:$.data.total_credits - credits:$.data.total_usage' },
    { id: 'today', label: 'Spent today', amount: 'key:$.data.usage_daily' },
    { id: 'week', label: 'Spent this week', amount: 'key:$.data.usage_weekly' },
    { id: 'month', label: 'Spent this month', amount: 'key:$.data.usage_monthly' }
  ]
};
