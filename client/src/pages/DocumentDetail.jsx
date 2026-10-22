import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadUrl, qs } from '../api.js';
import { ACTION_LABEL, Dialog, Empty, Notice, Stamp, describeEvent, formatBytes, formatDate } from '../ui.jsx';

const CATEGORIES = ['Contracts', 'HR', 'Finance', 'Legal', 'Engineering', 'Audit', 'General'];

export default function DocumentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState(null); // 'edit' | 'version' | 'trash'

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/documents/${encodeURIComponent(id)}`));
      setError('');
    } catch (err) {
      setData(null);
      setError(err.status === 404 ? 'This document does not exist, or it has not been shared with you.' : err.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <>
        <Link className="back" to="/documents">← All documents</Link>
        <div className="panel"><Empty title="Document not available">{error}</Empty></div>
      </>
    );
  }
  if (!data) return null;
  const { document: doc, versions, can } = data;

  async function moveToTrash() {
    try {
      await api.del(`/api/documents/${doc.id}`);
      navigate('/documents', { replace: true });
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <>
      <Link className="back" to="/documents">← All documents</Link>
      <div className="doc-header">
        <h1>{doc.title}</h1>
        <div className="doc-meta">
          <span><Stamp level={doc.myAccess} /></span>
          <span>Category <strong>{doc.category}</strong></span>
          <span>Owner <strong>{doc.ownerName}</strong></span>
          <span>Updated <strong>{formatDate(doc.updatedAt, true)}</strong></span>
        </div>
        {doc.description && <p style={{ marginTop: 12, maxWidth: '70ch' }}>{doc.description}</p>}
        <div className="doc-actions">
          <a className="button primary" href={downloadUrl(doc.id)} download>Download latest (v{doc.currentVersion})</a>
          {can.edit && <button type="button" onClick={() => setDialog('version')}>Upload new version</button>}
          {can.edit && <button type="button" onClick={() => setDialog('edit')}>Edit details</button>}
          {can.manage && <button type="button" className="danger" onClick={() => setDialog('trash')}>Move to trash</button>}
        </div>
      </div>

      <div style={{ marginTop: 20 }}><Notice kind="ok">{message}</Notice></div>

      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Versions</h2><p>Every download is recorded with the version and file fingerprint.</p></div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version}>
                      <td className="num">v{v.version}</td>
                      <td>{v.filename}<div className="sub" title={v.sha256}>SHA-256 {v.sha256.slice(0, 12)}…</div></td>
                      <td className="num">{formatBytes(v.size)}</td>
                      <td>{formatDate(v.createdAt, true)}<div className="sub">{v.uploadedBy}</div></td>
                      <td><a href={downloadUrl(doc.id, v.version)} download>Download</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {can.manage && <Activity docId={doc.id} />}
        </div>
        <div className="stack">
          {can.manage ? <Sharing docId={doc.id} onChange={setMessage} /> : (
            <section className="panel">
              <div className="panel-head"><h2>Your access</h2></div>
              <div className="panel-body">
                <p>{doc.myAccess === 'edit'
                  ? 'You can download, upload new versions and change the details. Only the owner can share or delete this document.'
                  : 'You can view and download this document. Only the owner can share it or change who has access.'}</p>
              </div>
            </section>
          )}
        </div>
      </div>

      {dialog === 'edit' && <EditDialog doc={doc} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setMessage('Details saved.'); load(); }} />}
      {dialog === 'version' && <VersionDialog doc={doc} onClose={() => setDialog(null)} onSaved={(v) => { setDialog(null); setMessage(`Version ${v} uploaded.`); load(); }} />}
      {dialog === 'trash' && (
        <Dialog
          title="Move to trash?"
          onClose={() => setDialog(null)}
          footer={<><button type="button" onClick={() => setDialog(null)}>Cancel</button><button type="button" className="danger" onClick={moveToTrash}>Move to trash</button></>}
        >
          <p>Everyone you shared it with loses access immediately. You can restore it from Trash, and their access comes back with it.</p>
        </Dialog>
      )}
    </>
  );
}

function Sharing({ docId, onChange }) {
  const [grants, setGrants] = useState([]);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState('');
  const [permission, setPermission] = useState('read');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const d = await api.get(`/api/documents/${docId}/grants`);
    setGrants(d.grants);
  }, [docId]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.get(`/api/users/directory${qs({ q: query })}`).then((d) => setPeople(d.users)).catch(() => setPeople([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const candidates = people.filter((p) => !grants.some((g) => g.userId === p.id));

  async function give(e) {
    e.preventDefault();
    if (!pick) return;
    setError('');
    try {
      await api.put(`/api/documents/${docId}/grants/${pick}`, { permission });
      const person = people.find((p) => p.id === pick);
      onChange(`${person ? person.name : 'They'} can now ${permission === 'edit' ? 'edit' : 'read'} this document.`);
      setPick('');
      setQuery('');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function change(g, value) {
    try {
      await api.put(`/api/documents/${docId}/grants/${g.userId}`, { permission: value });
      onChange(`${g.name} now has ${value} access.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(g) {
    try {
      await api.del(`/api/documents/${docId}/grants/${g.userId}`);
      onChange(`${g.name} no longer has access. Any download link or open page they had stops working now.`);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>Who has access</h2></div>
      {error && <div className="panel-body"><Notice kind="error">{error}</Notice></div>}
      {grants.length === 0 ? (
        <Empty title="Only you">Share with named people below.</Empty>
      ) : (
        <ul className="list">
          {grants.map((g) => (
            <li key={g.userId}>
              <div className="who">
                <div>{g.name} {!g.active && <span className="tag caution">Disabled</span>}</div>
                <div className="sub">{g.email}</div>
              </div>
              <select aria-label={`Access for ${g.name}`} value={g.permission} onChange={(e) => change(g, e.target.value)} style={{ width: 'auto' }}>
                <option value="read">Can read</option>
                <option value="edit">Can edit</option>
              </select>
              <button type="button" className="danger" onClick={() => remove(g)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form className="panel-body" onSubmit={give} style={{ borderTop: '1px solid var(--line)' }}>
        <h3 style={{ marginBottom: 10 }}>Share with a person</h3>
        <div className="field">
          <label htmlFor="person-search">Find by name or email</label>
          <input id="person-search" value={query} onChange={(e) => { setQuery(e.target.value); setPick(''); }} placeholder="Start typing a name" />
        </div>
        <div className="field">
          <label htmlFor="person">Person</label>
          <select id="person" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a person</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
          </select>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <div className="grow">
            <label htmlFor="perm">Access</label>
            <select id="perm" value={permission} onChange={(e) => setPermission(e.target.value)}>
              <option value="read">Can read</option>
              <option value="edit">Can edit</option>
            </select>
          </div>
          <button className="primary" type="submit" disabled={!pick}>Give access</button>
        </div>
        <p className="hint">Read: view and download. Edit: also upload new versions and change details. Only you can share or delete.</p>
      </form>
    </section>
  );
}

function Activity({ docId }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    api.get(`/api/documents/${docId}/activity`).then((d) => setEvents(d.events)).catch(() => setEvents([]));
  }, [docId]);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Activity</h2><p>Who did what to this document, including refused attempts.</p></div>
      {events && events.length === 0 && <Empty title="No activity yet" />}
      {events && events.length > 0 && (
        <ol className="chain">
          {events.slice(0, 50).map((e) => (
            <li key={e.seq} className={e.outcome}>
              <span className="seq">#{e.seq}</span>
              <span className="bar" aria-hidden="true" />
              <div>
                <div className="what">
                  {ACTION_LABEL[e.action] || e.action}{' '}
                  {e.outcome === 'denied' && <span className="tag denied">Refused</span>}
                </div>
                <div className="when">{e.actor || 'Not signed in'}, {formatDate(e.at, true)}</div>
                {describeEvent(e) && <div className="detail">{describeEvent(e)}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EditDialog({ doc, onClose, onSaved }) {
  const [title, setTitle] = useState(doc.title);
  const [category, setCategory] = useState(doc.category);
  const [description, setDescription] = useState(doc.description || '');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      await api.patch(`/api/documents/${doc.id}`, { title, category, description });
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Dialog title="Edit details" onClose={onClose} footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" form="edit-form">Save changes</button></>}>
      <form id="edit-form" onSubmit={submit} className="stack">
        <Notice kind="error">{error}</Notice>
        <div>
          <div className="field"><label htmlFor="e-title">Title</label><input id="e-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required /></div>
          <div className="field"><label htmlFor="e-cat">Category</label>
            <select id="e-cat" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="e-desc">Description</label><textarea id="e-desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
      </form>
    </Dialog>
  );
}

function VersionDialog({ doc, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!file) return setError('Choose a file.');
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    try {
      const d = await api.post(`/api/documents/${doc.id}/versions`, form);
      onSaved(d.version);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Dialog title="Upload new version" onClose={onClose} footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" form="ver-form" disabled={busy}>{busy ? 'Uploading…' : 'Upload version'}</button></>}>
      <form id="ver-form" onSubmit={submit} className="stack">
        <Notice kind="error">{error}</Notice>
        <div className="field">
          <label htmlFor="v-file">File</label>
          <input id="v-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv" onChange={(e) => setFile(e.target.files[0] || null)} />
          <p className="hint">The current version (v{doc.currentVersion}) is kept and stays downloadable.</p>
        </div>
      </form>
    </Dialog>
  );
}
