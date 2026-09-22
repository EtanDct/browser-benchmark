// Imported first by the CLI: Playwright resolves PLAYWRIGHT_BROWSERS_PATH when its module loads.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: environment variables only.
}
