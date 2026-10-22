'use strict';
const config = require('./config');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Never leak stack traces, SQL or internal ids to the client.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  if (err && err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 10 MB' : 'Invalid upload';
    return res.status(400).json({ error: message });
  }
  if (!config.isTest) console.error('[error]', err);
  return res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { HttpError, errorHandler };
