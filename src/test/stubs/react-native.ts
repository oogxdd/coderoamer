// Minimal react-native stub for node-based unit tests (vitest.config.ts alias).
export const Platform = {
  OS: 'ios' as string,
  select<T>(specifics: { ios?: T; android?: T; web?: T; default?: T }): T | undefined {
    return specifics.ios ?? specifics.default;
  },
};
