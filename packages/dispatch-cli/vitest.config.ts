import { defineConfig } from 'vitest/config';

// The web test makes about fifteen sequential CLI calls against two SQLite databases, which can take tens of seconds on a loaded Windows CI runner.
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 60000 } });
