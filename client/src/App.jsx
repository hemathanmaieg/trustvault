import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './api.js';
import { Logo } from './ui.jsx';
import Login from './pages/Login.jsx';
import Documents from './pages/Documents.jsx';
import DocumentDetail from './pages/DocumentDetail.jsx';
import Trash from './pages/Trash.jsx';
import Account from './pages/Account.jsx';
import Admin from './pages/Admin.jsx';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const ROLE_LABEL = { admin: 'Administrator', owner: 'Document owner', viewer: 'Viewer' };

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/api/auth/me').then((d) => setUser(d.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      navigate('/login', { replace: true });
    });
  }, [navigate]);

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  if (user === undefined) return null;

  if (!user) {
    return (
      <AuthContext.Provider value={{ user, setUser }}>
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      </AuthContext.Provider>
    );
  }

  const isAdmin = user.role === 'admin';
  return (
    <AuthContext.Provider value={{ user, setUser, signOut }}>
      <div className="shell">
        <header className="topbar">
          <NavLink to="/" className="brand"><Logo /> TrustVault</NavLink>
          <div className="spacer" />
          <div className="whoami">
            <span className="name">{user.name}</span>
            <span className="role">{ROLE_LABEL[user.role]}</span>
          </div>
          <button type="button" onClick={signOut}>Sign out</button>
        </header>
        <div className="body">
          <nav className="sidenav" aria-label="Main">
            {isAdmin ? (
              <>
                <NavLink to="/admin/alerts">Alerts</NavLink>
                <NavLink to="/admin/activity">Activity log</NavLink>
                <NavLink to="/admin/people">People</NavLink>
                <NavLink to="/admin/documents">Documents</NavLink>
              </>
            ) : (
              <>
                <NavLink to="/documents" end>Documents</NavLink>
                <NavLink to="/trash">Trash</NavLink>
              </>
            )}
            <div className="group">You</div>
            <NavLink to="/account">Password</NavLink>
          </nav>
          <main>
            <Routes>
              {isAdmin ? (
                <>
                  <Route path="/admin/:tab" element={<Admin />} />
                  <Route path="*" element={<Navigate to="/admin/alerts" replace />} />
                </>
              ) : (
                <>
                  <Route path="/documents" element={<Documents />} />
                  <Route path="/documents/:id" element={<DocumentDetail />} />
                  <Route path="/trash" element={<Trash />} />
                  <Route path="*" element={<Navigate to="/documents" replace />} />
                </>
              )}
              <Route path="/account" element={<Account />} />
            </Routes>
          </main>
        </div>
      </div>
    </AuthContext.Provider>
  );
}
