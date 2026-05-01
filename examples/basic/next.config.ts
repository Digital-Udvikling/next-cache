import type { NextConfig } from "next";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const config: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve("./cache-handlers/default.cjs"),
    remote: require.resolve("./cache-handlers/remote.cjs"),
  },
};

export default config;
