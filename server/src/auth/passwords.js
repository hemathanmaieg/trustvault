'use strict';
const bcrypt = require('bcryptjs');
const config = require('../config');

const COST = config.isTest ? 4 : 12;
// Used when the email is unknown so the response time does not reveal
// whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-just-for-timing', COST);

function validatePasswordStrength(password) {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 200) return 'Password is too long';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain letters and numbers';
  }
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, COST);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(String(password || ''), hash || DUMMY_HASH);
}

module.exports = { hashPassword, verifyPassword, validatePasswordStrength, DUMMY_HASH };
