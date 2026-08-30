import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost:4173',
      },
    },
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
});
