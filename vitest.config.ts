import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['@chat-adapter/tests/setup'],
  },
});
