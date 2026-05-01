import { execSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Playwright's bundled chromium-headless-shell is dynamically linked against
// glibc + a long list of shared libraries, which fails to load on NixOS where
// those libs aren't on the standard search path. Detect a system-installed
// chromium and use it via executablePath when available; otherwise fall back
// to Playwright's bundled browser.
function findSystemChromium(): string | undefined {
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const path = execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim();
      if (path) return path;
    } catch {
      // not found, continue
    }
  }
  return undefined;
}

const systemChromium = findSystemChromium();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    launchOptions: systemChromium ? { executablePath: systemChromium } : undefined,
  },
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
