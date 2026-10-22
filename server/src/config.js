'use strict';
// Central configuration. Every secret comes from environment variables;
// nothing secret is committed to the repository.
require('dotenv').config({ quiet: true });

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';
const isTest = env === 'test';

function required(name, fallbackForDev) {
  const value = process.env[name];
  if (value) return value;
  if (!isProd && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable ${name}`);
}

const config = {
  env,
  isProd,
  isTest,
  port: Number(process.env.PORT || 3000),
  databaseUrl: required(
    'DATABASE_URL',
    isTest
      ? 'postgres://trustvault:trustvault_local@localhost:5432/trustvault_test'
      : 'postgres://trustvault:trustvault_local@localhost:5432/trustvault_dev'
  ),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  // Secret key for the audit hash chain. Kept outside the database so that
  // someone with database access alone cannot forge a valid chain.
  auditHmacKey: required('AUDIT_HMAC_KEY', 'dev-only-audit-key-change-me'),
  session: {
    cookieName: isProd ? '__Host-tv_session' : 'tv_session',
    idleMinutes: Number(process.env.SESSION_IDLE_MINUTES || 30),
    absoluteHours: Number(process.env.SESSION_ABSOLUTE_HOURS || 8),
  },
  login: {
    maxFailures: 5,
    lockMinutes: 15,
  },
  rateLimit: {
    // Generous for real use; effectively off in tests (tests that check the
    // limits build their own app with small numbers).
    apiPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE || (isTest ? 100000 : 300)),
    anonPerMinute: Number(process.env.RATE_LIMIT_ANON_PER_MINUTE || (isTest ? 100000 : 30)),
    loginPer15Min: Number(process.env.RATE_LIMIT_LOGIN || (isTest ? 100000 : 20)),
  },
  upload: {
    maxBytes: 10 * 1024 * 1024,
  },
  // Behind Render's proxy we trust exactly one hop for the client IP.
  trustProxy: isProd ? 1 : false,
};

module.exports = config;
