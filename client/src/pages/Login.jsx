import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { Logo, Notice } from '../ui.jsx';

export default function Login() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api.post('/api/auth/login', { email, password });
      setUser(d.user);
      navigate(d.user.role === 'admin' ? '/admin/alerts' : '/documents', { replace: true });
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><Logo /> TrustVault</div>
        <h1>Sign in</h1>
        <p className="lead">Confidential documents, shared only with the people named on them.</p>
        <div className="stack">
          <Notice kind="error">{error}</Notice>
          <div>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
          </div>
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="hint">Five wrong passwords lock the account for 15 minutes. Every sign-in attempt is recorded.</p>
        </div>
      </form>
    </div>
  );
}
