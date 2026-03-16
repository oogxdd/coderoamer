const createExpoWebpackConfigAsync = require('@expo/webpack-config');
const CopyPlugin = require("copy-webpack-plugin");
const path = require("path");

module.exports = async function (env, argv) {
  const config = await createExpoWebpackConfigAsync(env, argv);
  // Customize the config before returning it.
  
  config.plugins.push(
    new CopyPlugin({
      patterns: [
        {
          from: path.join(
            path.dirname(require.resolve("canvaskit-wasm/package.json")),
            "bin/full/canvaskit.wasm"
          ),
        },
      ],
    })
  );

  return config;
};
