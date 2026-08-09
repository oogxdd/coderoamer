const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// expo-sqlite's web worker imports its SQLite runtime as a WebAssembly asset.
config.resolver.assetExts.push('wasm');

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  punycode: require.resolve('punycode/'),
};

// Fix @babel/runtime resolution: v7.28+ exports map uses keys without .js
// but internal helpers require("./file.js") with .js — Metro can't match them.
const babelRuntimeHelpersDir = path.join(
  __dirname,
  'node_modules',
  '@babel',
  'runtime',
  'helpers'
);

const originalResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // When resolving from @babel/runtime/helpers, strip trailing .js so
  // the exports map (which omits .js) can match.
  if (
    context.originModulePath?.startsWith(babelRuntimeHelpersDir) &&
    moduleName.startsWith('./') &&
    moduleName.endsWith('.js')
  ) {
    const stripped = moduleName.slice(0, -3);
    try {
      if (originalResolveRequest) {
        return originalResolveRequest(context, stripped, platform);
      }
      return context.resolveRequest(context, stripped, platform);
    } catch {
      // fall through to default
    }
  }

  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
