'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { loadSession } = require('./auth/session');
const { csrfProtect, requireAuth, requireAdmin, rejectBadText } = require('./guards');
const { limiter } = require('./ratelimit');
const { errorHandler } = require('./errors');

function createApp(options = {}) {
  const limits = { ...config.rateLimit, ...options.rateLimit };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );

  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());

  // API: no caching of anything personal.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Per-address limits: everyone, and a much tighter one for people not signed in.
  const apiLimiter = limiter({
    windowMs: 60 * 1000, limit: limits.apiPerMinute, action: 'rate_limit',
    message: 'Too many requests. Wait a minute and try again.',
  });
  const anonLimiter = limiter({
    windowMs: 60 * 1000, limit: limits.anonPerMinute, action: 'rate_limit',
    message: 'Too many requests. Wait a minute and try again.',
    skip: (req) => Boolean(req.user) || req.path === '/health',
  });

  app.use('/api', loadSession, apiLimiter, anonLimiter, rejectBadText, csrfProtect);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/documents', requireAuth, require('./routes/documents')); // AUTHZ:mountDocumentsAuth -> app.use('/api/documents', require('./routes/documents'));
  app.use('/api/users', requireAuth, require('./routes/users')); // AUTHZ:mountUsersAuth -> app.use('/api/users', require('./routes/users'));
  app.use('/api/admin', requireAuth, requireAdmin, require('./routes/admin')); // AUTHZ:mountAdminRole -> app.use('/api/admin', requireAuth, require('./routes/admin'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The built React app. It contains no data; everything comes through /api.
  const dist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
