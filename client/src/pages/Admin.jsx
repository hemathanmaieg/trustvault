import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../App.jsx';
import { ACTION_LABEL, Dialog, Empty, Notice, describeEvent, formatDate } from '../ui.jsx';

export default function Admin() {
  const { tab } = useParams();
  if (tab === 'activity') return <ActivityLog />;
  if (tab === 'people') return <People />;
  if (tab === 'documents') return <DocumentOverview />;
  return <Alerts />;
}

// ---------------------------------------------------------------------------
function Alerts() {
  const [a, setA] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/api/admin/alerts').then(setA).catch((e) => setError(e.message)); }, []);
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!a) return null;
  const cards = [
    {
      key: 'revoke', label: 'Tried again after access was removed', rows: a.attemptsAfterRevoke,
      line: (r) => `${r.who} on "${r.title || 'deleted document'}", ${formatDate(r.attempted_at, true)}`,
    },
    {
      key: 'denials', label: 'Refused 5 or more times in 24 hours', rows: a.repeatedDenials,
      line: (r) => `${r.who}: ${r.denied} refusals, last ${formatDate(r.last_at, true)}`,
    },
    {
      key: 'bulk', label: '10 or more downloads in the last hour', rows: a.bulkDownloads,
      line: (r) => `${r.who}: ${r.downloads} downloads of ${r.documents} documents`,
    },
    {
      key: 'locked', label: 'Accounts locked by wrong passwords (24 hours)', rows: a.lockedAccounts,
      line: (r) => `${r.who}, ${formatDate(r.locked_at, true)}`,
    },
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Patterns worth a look. Filter the activity log by the person named to see every entry behind them.</p>
        </div>
      </div>
      <div className="alert-grid">
        {cards.map((c) => (
          <div key={c.key} className={`alert-card ${c.rows.length ? 'hot' : ''}`}>
            <div className="label">{c.label}</div>
            <div className="count">{c.rows.length}</div>
            {c.rows.length > 0 && <ul>{c.rows.slice(0, 6).map((r, i) => <li key={i}>{c.line(r)}</li>)}</ul>}
          </div>
        ))}
        <div className="alert-card">
          <div className="label">Access changes in 24 hours</div>
          <div className="count">{a.permissionChanges24h}</div>
          <p className="hint">Grants, changes and removals. See the activity log for each one.</p>
        </div>
      </div>
      <div style={{ marginTop: 20 }}><ChainCheck /></div>
    </>
  );
}

function ChainCheck() {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try { setResult(await api.get('/api/admin/audit/verify')); } catch (e) { setResult({ ok: false, problem: e.message }); }
    setBusy(false);
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Audit log integrity</h2>
          <p>Each entry is sealed with a keyed hash of the one before. Any edited, removed or inserted entry breaks the chain.</p>
        </div>
        <button type="button" className="primary" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check the chain'}</button>
      </div>
      {result && (
        <div className="panel-body">
          {result.ok
            ? <Notice kind="ok">Intact. All {result.checked} entries verified. Latest entry #{result.headSeq}, seal {result.headHash.slice(0, 16)}…</Notice>
            : <Notice kind="error">Broken. {result.problem}</Notice>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
const ACTIONS = Object.keys(ACTION_LABEL);

function ActivityLog() {
  const [f, setF] = useState({ action: '', outcome: '', actor: '', from: '', to: '', page: 1 });
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async (filters) => {
    setError('');
    try { setEvents((await api.get(`/api/admin/audit${qs(filters)}`)).events); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(f); }, [f.page]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e) => { e.preventDefault(); const nf = { ...f, page: 1 }; setF(nf); load(nf); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity log</h1>
          <p>Every sign-in, upload, download, change, deletion and access change, including every refused attempt. Entries cannot be edited or removed.</p>
        </div>
      </div>
      <div className="panel">
        <form className="filters" onSubmit={submit}>
          <div className="wide">
            <label htmlFor="actor">Person</label>
            <input id="actor" placeholder="Email" value={f.actor} onChange={set('actor')} />
          </div>
          <div>
            <label htmlFor="action">Action</label>
            <select id="action" value={f.action} onChange={set('action')}>
              <option value="">Any</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="outcome">Result</label>
            <select id="outcome" value={f.outcome} onChange={set('outcome')}>
              <option value="">Any</option>
              <option value="allowed">Allowed</option>
              <option value="denied">Refused</option>
            </select>
          </div>
          <div><label htmlFor="afrom">From</label><input id="afrom" type="date" value={f.from} onChange={set('from')} /></div>
          <div><label htmlFor="ato">To</label><input id="ato" type="date" value={f.to} onChange={set('to')} /></div>
          <div className="row"><button className="primary" type="submit">Filter</button></div>
        </form>
        {error && <div className="panel-body"><Notice kind="error">{error}</Notice></div>}
        {events && events.length === 0 && <Empty title="No entries match these filters" />}
        {events && events.length > 0 && (
          <ol className="chain">
            {events.map((e) => (
              <li key={e.seq} className={e.outcome}>
                <span className="seq">#{e.seq}</span>
                <span className="bar" aria-hidden="true" />
                <div>
                  <div className="what">
                    {ACTION_LABEL[e.action] || e.action}
                    {e.documentTitle && <> on <span style={{ fontFamily: 'var(--serif)' }}>"{e.documentTitle}"</span></>}
                    {e.targetEmail && <> for {e.targetEmail}</>}{' '}
                    {e.outcome === 'denied' && <span className="tag denied">Refused</span>}
                  </div>
                  <div className="when">{e.actor || 'Not signed in'}, {formatDate(e.at, true)}{e.ip ? `, from ${e.ip}` : ''}</div>
                  {describeEvent(e) && <div className="detail">{describeEvent(e)}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className="panel-head" style={{ borderTop: '1px solid var(--line)', borderBottom: 0 }}>
          <button type="button" disabled={f.page <= 1} onClick={() => setF((x) => ({ ...x, page: x.page - 1 }))}>Newer</button>
          <span className="sub">Page {f.page}</span>
          <button type="button" disabled={!events || events.length < 100} onClick={() => setF((x) => ({ ...x, page: x.page + 1 }))}>Older</button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
const ROLE = { admin: 'Administrator', owner: 'Document owner', viewer: 'Viewer' };

function People() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null);

  const load = useCallback(() => api.get('/api/admin/users').then((d) => setUsers(d.users)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function update(u, body, done) {
    setError(''); setMessage('');
    try { await api.patch(`/api/admin/users/${u.id}`, body); setMessage(done); load(); } catch (e) { setError(e.message); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p>Changing someone's role or disabling them signs them out immediately. Administrators cannot open documents.</p>
        </div>
        <button type="button" className="primary" onClick={() => setDialog({ type: 'create' })}>Add person</button>
      </div>
      <div className="stack">
        <Notice kind="ok">{message}</Notice>
        <Notice kind="error">{error}</Notice>
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me.id;
                return (
                  <tr key={u.id}>
                    <td>{u.name}{self && ' (you)'}<div className="sub">{u.email}</div></td>
                    <td>
                      <select aria-label={`Role for ${u.name}`} value={u.role} disabled={self} style={{ width: 'auto' }}
                        onChange={(e) => update(u, { role: e.target.value }, `${u.name} is now ${ROLE[e.target.value]}. They have been signed out.`)}>
                        {Object.entries(ROLE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </td>
                    <td>
                      {u.active ? <span className="tag allowed">Active</span> : <span className="tag denied">Disabled</span>}{' '}
                      {u.lockedUntil && <span className="tag caution">Locked</span>}
                    </td>
                    <td>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {u.lockedUntil && <button type="button" onClick={() => update(u, { unlock: true }, `${u.name} unlocked.`)}>Unlock</button>}
                        <button type="button" onClick={() => setDialog({ type: 'password', user: u })}>Reset password</button>
                        {!self && (u.active
                          ? <button type="button" className="danger" onClick={() => update(u, { active: false }, `${u.name} disabled and signed out everywhere.`)}>Disable</button>
                          : <button type="button" onClick={() => update(u, { active: true }, `${u.name} enabled.`)}>Enable</button>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {dialog && dialog.type === 'create' && <CreateUser onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); setMessage(m); load(); }} />}
      {dialog && dialog.type === 'password' && <ResetPassword user={dialog.user} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); setMessage(m); }} />}
    </>
  );
}

function CreateUser({ onClose, onDone }) {
  const [v, setV] = useState({ name: '', email: '', role: 'viewer', password: '' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    try { await api.post('/api/admin/users', v); onDone(`${v.name} added as ${ROLE[v.role]}.`); } catch (err) { setError(err.message); }
  }
  return (
    <Dialog title="Add person" onClose={onClose} footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" form="create-user">Add person</button></>}>
      <form id="create-user" onSubmit={submit} className="stack">
        <Notice kind="error">{error}</Notice>
        <div>
          <div className="field"><label htmlFor="n">Name</label><input id="n" value={v.name} onChange={set('name')} required /></div>
          <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" value={v.email} onChange={set('email')} required /></div>
          <div className="field"><label htmlFor="r">Role</label>
            <select id="r" value={v.role} onChange={set('role')}>{Object.entries(ROLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="pw">Temporary password</label><input id="pw" type="password" autoComplete="new-password" value={v.password} onChange={set('password')} required minLength={12} />
            <p className="hint">At least 12 characters, with letters and numbers.</p></div>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPassword({ user, onClose, onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try { await api.post(`/api/admin/users/${user.id}/password`, { password }); onDone(`Password reset for ${user.name}. They have been signed out everywhere.`); } catch (err) { setError(err.message); }
  }
  return (
    <Dialog title={`Reset password for ${user.name}`} onClose={onClose} footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" form="reset-pw">Reset password</button></>}>
      <form id="reset-pw" onSubmit={submit} className="stack">
        <Notice kind="error">{error}</Notice>
        <div className="field"><label htmlFor="rp">New password</label><input id="rp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} /></div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function DocumentOverview() {
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/api/admin/documents').then((d) => setDocs(d.documents)).catch((e) => setError(e.message)); }, []);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Documents</h1>
          <p>Titles and activity only. Administrators cannot open or download any document.</p>
        </div>
      </div>
      <Notice kind="error">{error}</Notice>
      <div className="panel table-wrap">
        {docs && docs.length === 0 && <Empty title="No documents yet" />}
        {docs && docs.length > 0 && (
          <table>
            <thead><tr><th>Document</th><th>Owner</th><th>Shared with</th><th>Downloads</th><th>Refused</th><th>Last activity</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td><span className="doc-title">{d.title}</span>{d.deleted && <> <span className="tag caution">In trash</span></>}<div className="sub">{d.category}, {d.versions} {d.versions === 1 ? 'version' : 'versions'}</div></td>
                  <td>{d.owner}</td>
                  <td className="num">{d.grants}</td>
                  <td className="num">{d.downloads}</td>
                  <td className="num">{d.denied ? <span className="tag denied">{d.denied}</span> : 0}</td>
                  <td className="num">{formatDate(d.lastActivity, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
