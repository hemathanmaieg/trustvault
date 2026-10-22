import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useAuth } from '../App.jsx';
import { Dialog, Empty, Notice, Stamp, formatDate } from '../ui.jsx';

const CATEGORIES = ['Contracts', 'HR', 'Finance', 'Legal', 'Engineering', 'Audit', 'General'];
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv';

export default function Documents() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ q: '', owner: '', category: '', from: '', to: '', scope: 'all' });
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const canUpload = user.role === 'owner';

  const load = useCallback(async (f) => {
    setError('');
    try {
      const d = await api.get(`/api/documents${qs(f)}`);
      setDocs(d.documents);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(filters); }, [filters.scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const search = (e) => { e.preventDefault(); load(filters); };
  const clear = () => { const f = { q: '', owner: '', category: '', from: '', to: '', scope: filters.scope }; setFilters(f); load(f); };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Documents</h1>
          <p>Everything here was shared with you by name, or uploaded by you. Nothing else is listed or searchable.</p>
        </div>
        {canUpload && <button className="primary" type="button" onClick={() => setShowUpload(true)}>Upload document</button>}
      </div>

      <div className="panel">
        <form className="filters" onSubmit={search}>
          <div className="wide">
            <label htmlFor="q">Name</label>
            <input id="q" placeholder="Search by document name" value={filters.q} onChange={set('q')} />
          </div>
          <div>
            <label htmlFor="owner">Owner</label>
            <input id="owner" placeholder="Name or email" value={filters.owner} onChange={set('owner')} />
          </div>
          <div>
            <label htmlFor="category">Category</label>
            <select id="category" value={filters.category} onChange={set('category')}>
              <option value="">Any</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="from">Added from</label>
            <input id="from" type="date" value={filters.from} onChange={set('from')} />
          </div>
          <div>
            <label htmlFor="to">Added to</label>
            <input id="to" type="date" value={filters.to} onChange={set('to')} />
          </div>
          <div className="row">
            <button className="primary" type="submit">Search</button>
            <button type="button" onClick={clear}>Clear</button>
          </div>
        </form>
        <div className="panel-head" style={{ borderBottom: docs && docs.length ? '1px solid var(--line)' : 0 }}>
          {canUpload ? (
          <div className="segmented" role="group" aria-label="Show">
            {[['all', 'All'], ['mine', 'Uploaded by me'], ['shared', 'Shared with me']].map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filters.scope === v} onClick={() => setFilters((f) => ({ ...f, scope: v }))}>{l}</button>
            ))}
          </div>
          ) : <h2>Shared with you</h2>}
          {docs && <p>{docs.length} {docs.length === 1 ? 'document' : 'documents'}</p>}
        </div>
        {error && <div className="panel-body"><Notice kind="error">{error}</Notice></div>}
        {docs && docs.length === 0 && (
          <Empty title="No documents match">
            {canUpload ? 'Upload a document, or change the search.' : 'Documents appear here once an owner shares them with you.'}
          </Empty>
        )}
        {docs && docs.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Document</th><th className="hide-sm">Category</th><th className="hide-sm">Owner</th><th className="hide-sm">Updated</th><th>Your access</th></tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`)}>
                    <td>
                      <Link className="doc-title" to={`/documents/${d.id}`} onClick={(e) => e.stopPropagation()}>{d.title}</Link>
                      {d.description && <div className="sub">{d.description}</div>}
                      <div className="sub show-sm">{d.category}, owned by {d.ownerName}</div>
                    </td>
                    <td className="hide-sm">{d.category}</td>
                    <td className="hide-sm">{d.ownerName}<div className="sub">{d.ownerEmail}</div></td>
                    <td className="num hide-sm">{formatDate(d.updatedAt)}</td>
                    <td><Stamp level={d.myAccess} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showUpload && (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onDone={(id) => navigate(`/documents/${id}`)}
        />
      )}
    </>
  );
}

function UploadDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('General');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!file) return setError('Choose a file to upload.');
    if (file.size > 10 * 1024 * 1024) return setError('File is larger than 10 MB.');
    const form = new FormData();
    form.append('title', title);
    form.append('category', category);
    form.append('description', description);
    form.append('file', file);
    setBusy(true);
    setError('');
    try {
      const d = await api.post('/api/documents', form);
      onDone(d.id);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Upload document"
      onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" form="upload-form" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button></>}
    >
      <form id="upload-form" onSubmit={submit} className="stack">
        <Notice kind="error">{error}</Notice>
        <div>
          <div className="field">
            <label htmlFor="file">File</label>
            <input id="file" type="file" accept={ACCEPT} onChange={(e) => { const f = e.target.files[0]; setFile(f || null); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '')); }} />
            <p className="hint">PDF, PNG, JPG, Word (.docx), Excel (.xlsx), TXT or CSV, up to 10 MB. The file's contents are checked, not just its name.</p>
          </div>
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="cat">Category</label>
            <select id="cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="desc">Description (optional)</label>
            <textarea id="desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <Notice kind="info">Only you can see this document until you share it with named people.</Notice>
      </form>
    </Dialog>
  );
}
