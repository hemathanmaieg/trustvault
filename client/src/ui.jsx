import React, { useEffect, useRef } from 'react';

export const ACCESS_LABEL = { owner: 'Owner', edit: 'Can edit', read: 'Can read' };

export function Stamp({ level }) {
  if (!level) return null;
  return <span className={`stamp ${level}`}>{ACCESS_LABEL[level] || level}</span>;
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return (
    <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 4l10 3.6v7.2c0 6-4.2 11-10 13.2C10.2 25.8 6 20.8 6 14.8V7.6z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M11.8 16l3 3 5.4-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function formatDate(value, withTime = false) {
  if (!value) return '';
  const d = new Date(value);
  return d.toLocaleString(undefined, withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Dialog({ title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const first = ref.current && ref.current.querySelector('input, select, textarea, button');
    if (first) first.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="panel-head">
          <h2>{title}</h2>
          <button type="button" className="link-button" onClick={onClose}>Close</button>
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Human words for audit actions.
export const ACTION_LABEL = {
  login: 'Sign-in',
  logout: 'Sign-out',
  upload: 'Uploaded',
  new_version: 'New version',
  download: 'Downloaded',
  view: 'Opened details',
  update_details: 'Changed details',
  delete: 'Moved to trash',
  restore: 'Restored',
  grant: 'Gave access',
  grant_change: 'Changed access',
  revoke: 'Removed access',
  list_grants: 'Viewed access list',
  view_activity: 'Viewed activity',
  unauthenticated_request: 'Request without sign-in',
  csrf_check: 'Blocked cross-site request',
  admin_access: 'Admin area',
  user_directory: 'People directory',
  user_create: 'Created user',
  user_update: 'Changed user',
  password_change: 'Changed password',
  password_reset: 'Reset password',
  account_locked: 'Account locked',
  audit_verify: 'Checked audit chain',
  rate_limit: 'Too many requests',
  malformed_request: 'Malformed request',
};

export function describeEvent(e) {
  const d = e.details || {};
  const bits = [];
  if (d.reason) bits.push(`reason: ${d.reason.replace(/_/g, ' ')}`);
  if (d.email && e.action !== 'login') bits.push(d.email);
  if (e.action === 'login' && d.email) bits.push(d.email);
  if (d.from !== undefined && d.to !== undefined) bits.push(`${d.from || 'none'} → ${d.to}`);
  else if (d.permission) bits.push(d.permission);
  if (d.version) bits.push(`version ${d.version}`);
  if (d.filename) bits.push(d.filename);
  if (d.changes) bits.push(`changed ${Object.keys(d.changes).join(', ')}`);
  if (d.message) bits.push(d.message);
  if (d.requested_id) bits.push(`tried id "${d.requested_id}"`);
  if (d.problem) bits.push(d.problem);
  if (Array.isArray(d.access_restored_for) && d.access_restored_for.length) bits.push(`access back for ${d.access_restored_for.join(', ')}`);
  return bits.join('; ');
}
