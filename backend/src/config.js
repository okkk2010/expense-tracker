import { fileURLToPath } from 'node:url';

export function loadSettings(overrides = {}) {
  const settings = {
    dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/ledger.sqlite3', import.meta.url)),
    accessToken: process.env.APP_ACCESS_TOKEN || '',
    environment: process.env.APP_ENV || 'development',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',').map(value => value.trim()).filter(Boolean),
    restoreMaxBytes: 10 * 1024 * 1024,
    ...overrides,
  };
  if (settings.environment === 'production' && !settings.accessToken) {
    throw new Error('APP_ACCESS_TOKEN is required in production');
  }
  if (!Array.isArray(settings.corsOrigins) || settings.corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGINS must contain explicit allowed origins');
  }
  if (!Number.isSafeInteger(settings.restoreMaxBytes) || settings.restoreMaxBytes < 1) {
    throw new Error('restoreMaxBytes must be a positive integer');
  }
  return settings;
}
