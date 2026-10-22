import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Empty, Notice, formatDate } from '../ui.jsx';

export default function Trash() {
  const [docs, setDocs] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get('/api/documents/trash').then((d) => setDocs(d.documents)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function restore(d) {
    try {
      await api.post(`/api/documents/${d.id}/restore`);
      setMessage(`"${d.title}" restored. People it was shared with can reach it again.`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trash</h1>
          <p>Documents you moved to trash. Nobody can open them, including you, until you restore them.</p>
        </div>
      </div>
      <div className="stack">
        <Notice kind="ok">{message}</Notice>
        <Notice kind="error">{error}</Notice>
        <div className="panel">
          {docs && docs.length === 0 && <Empty title="Trash is empty" />}
          {docs && docs.length > 0 && (
            <ul className="list">
              {docs.map((d) => (
                <li key={d.id}>
                  <div className="who">
                    <div className="doc-title">{d.title}</div>
                    <div className="sub">{d.category}, moved to trash {formatDate(d.deletedAt, true)}</div>
                  </div>
                  <button type="button" onClick={() => restore(d)}>Restore</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
