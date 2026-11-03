export type Principal = { kind: 'owner' } | { kind: 'user'; user: string; device?: string; via?: 'access' };
