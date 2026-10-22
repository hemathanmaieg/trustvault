import React, { useState } from 'react';
import { api } from '../api.js';
import { Notice } from '../ui.jsx';

export default function Account() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setMessage('');
    setError('');
    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
      setMessage('Password changed. You have been signed out on every other device.');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head"><div><h1>Password</h1><p>Changing your password signs you out everywhere else.</p></div></div>
      <form className="panel panel-body stack" onSubmit={submit} style={{ maxWidth: 460 }}>
        <Notice kind="ok">{message}</Notice>
        <Notice kind="error">{error}</Notice>
        <div>
          <div className="field"><label htmlFor="cur">Current password</label><input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></div>
          <div className="field"><label htmlFor="new">New password</label><input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} />
            <p className="hint">At least 12 characters, with letters and numbers.</p></div>
        </div>
        <div><button className="primary" type="submit">Change password</button></div>
      </form>
    </>
  );
}
