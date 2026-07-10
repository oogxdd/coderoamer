import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests cover the pure chat-pipeline logic (stream parsers, transcript
// merging, shell command builders). React Native / Expo modules are aliased to
// tiny stubs so service modules that only need Platform.OS can be imported in
// a node environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'react-native': path.resolve(__dirname, 'src/test/stubs/react-native.ts'),
      'expo-secure-store': path.resolve(__dirname, 'src/test/stubs/expo-secure-store.ts'),
    },
  },
});
