'use strict';
// Upload validation. We trust the file's bytes, not its name or the
// Content-Type the browser claims.
const crypto = require('crypto');
const path = require('path');
// file-type is published as an ES module only; load it once, lazily.
let fileTypeFromBuffer;
async function detectType(buffer) {
  if (!fileTypeFromBuffer) ({ fileTypeFromBuffer } = await import('file-type'));
  return fileTypeFromBuffer(buffer);
}
const { HttpError } = require('../errors');
const config = require('../config');

// extension -> MIME type we store and the type file-type must detect
const ALLOWED = {
  pdf: { mime: 'application/pdf', detect: 'pdf' },
  png: { mime: 'image/png', detect: 'png' },
  jpg: { mime: 'image/jpeg', detect: 'jpg' },
  jpeg: { mime: 'image/jpeg', detect: 'jpg' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', detect: 'docx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', detect: 'xlsx' },
  txt: { mime: 'text/plain', detect: null },
  csv: { mime: 'text/csv', detect: null },
};

const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

/** Keep only a safe display name: no folders, no control characters, no quotes. */
function sanitizeFilename(original) {
  const base = path.posix.basename(String(original || '').replace(/\\/g, '/'));
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>|:*?‪-‮⁦-⁩]/g, '') // control chars, reserved chars, bidi overrides
    .replace(/^\.+/, '') // no hidden / dot-only names
    .trim();
  if (!cleaned) throw new HttpError(400, 'File name is not valid');
  if (cleaned.length > 150) throw new HttpError(400, 'File name is too long (max 150 characters)');
  return cleaned;
}

function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validate an uploaded file (from multer memory storage).
 * Returns { filename, mimeType, size, sha256, content }.
 */
async function validateUpload(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new HttpError(400, 'Choose a file to upload');
  const size = file.buffer.length;
  if (size === 0) throw new HttpError(400, 'The file is empty');
  if (size > config.upload.maxBytes) throw new HttpError(400, 'File is larger than 10 MB');

  const filename = sanitizeFilename(file.originalname);
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const rule = ALLOWED[ext];
  if (!rule) {
    throw new HttpError(400, `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }

  const detected = await detectType(file.buffer);
  if (rule.detect) {
    if (!detected || detected.ext !== rule.detect) {
      throw new HttpError(400, `The file content does not match its .${ext} extension`);
    }
  } else {
    // Plain text formats have no signature: require clean UTF-8 text and
    // make sure it is not a recognised binary format in disguise.
    if (detected || !looksLikeText(file.buffer)) {
      throw new HttpError(400, `The file content does not match its .${ext} extension`);
    }
  }

  return {
    filename,
    mimeType: rule.mime,
    size,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    content: file.buffer,
  };
}

module.exports = { validateUpload, sanitizeFilename, ALLOWED_EXTENSIONS };
