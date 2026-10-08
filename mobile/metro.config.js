// Expo's Metro config. SDK ≥ 52 configures pnpm monorepos itself (watchFolders = workspace root, node_modules
// lookup): docs.expo.dev/guides/monorepos "Expo configures Metro automatically for monorepos". Package `exports`
// (how @meridian/core and @meridian/abis/*.json resolve) is on by default in Metro since SDK 53.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
