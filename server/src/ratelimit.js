'use strict';
// Request rate limits. They stop one address from flooding the API or the audit
// log. When a limit is first hit in a window, ONE audit entry is written (not
// one per request), so the limit itself cannot be used to fill the log.
const rateLimit = require('express-rate-limit');
const audit = require('./audit');

function limiter({ windowMs, limit, action, message, skip, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    skip,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: async (req, res) => {
      const info = req.rateLimit || {};
      if (info.used === info.limit + 1) {
        await audit.record(audit.fromReq(req, {
          action, outcome: 'denied',
          details: { reason: 'rate_limited', limit: info.limit, window_seconds: Math.round(windowMs / 1000), path: req.originalUrl.slice(0, 200) },
        })).catch(() => {});
      }
      res.status(429).json({ error: message });
    },
  });
}

module.exports = { limiter };
