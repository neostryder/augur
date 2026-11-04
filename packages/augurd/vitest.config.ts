import { defineConfig } from 'vitest/config';

// Most service tests build a home folder, a database and a supervisor, which takes under a second here but tens of seconds on a loaded Windows CI runner.
export default defineConfig({ test: { testTimeout: 60000, hookTimeout: 60000 } });
