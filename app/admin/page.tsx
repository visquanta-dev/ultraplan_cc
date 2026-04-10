'use client';

import { useState, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Admin dashboard — spec §8
// Five views: Pipeline status, Blocked drafts, PR queue, Run history,
// Rejection log. Basic auth handled by API routes.
// ---------------------------------------------------------------------------

type Tab = 'status' | 'blocked' | 'runs' | 'rejections';

interface Run {
  slug: string;
  lane: string;
  status: string;
  verdict: string;
  created_at: string;
  gate_scores?: Record<string, number>;
  manual_override?: { approved_at: string; reason: string };
}

interface BlockedDraft {
  slug: string;
  lane: string;
  blocked_reason: string;
  created_at: string;
  gate_report: { results: Array<{ gate: string; passed: boolean; summary: string }> };
}

interface Rejection {
  date: string;
  slug: string;
  lane: string;
  reason: string;
  feedback: string;
  reviewer: string;
  pr_url: string;
}

function getAuthHeaders(): HeadersInit {
  // In a real app this would come from a login form stored in sessionStorage
  const user = prompt('Admin username:') ?? '';
  const pass = prompt('Admin password:') ?? '';
  return {
    Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
  };
}

let cachedHeaders: HeadersInit | null = null;

function authHeaders(): HeadersInit {
  if (!cachedHeaders) {
    cachedHeaders = getAuthHeaders();
  }
  return cachedHeaders;
}

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('status');
  const [runs, setRuns] = useState<Run[]>([]);
  const [blocked, setBlocked] = useState<BlockedDraft[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData(tab);
  }, [tab]);

  async function loadData(activeTab: Tab) {
    setLoading(true);
    setError(null);
    try {
      const headers = authHeaders();
      if (activeTab === 'runs' || activeTab === 'status') {
        const res = await fetch('/api/admin/runs', { headers });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        setRuns(data.runs ?? []);
      }
      if (activeTab === 'blocked') {
        const res = await fetch('/api/admin/blocked', { headers });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        setBlocked(data.blocked ?? []);
      }
      if (activeTab === 'rejections') {
        const res = await fetch('/api/admin/reject', { headers });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = await res.json();
        setRejections(data.rejections ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      cachedHeaders = null; // reset auth on failure
    } finally {
      setLoading(false);
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'status', label: 'Pipeline Status' },
    { id: 'blocked', label: 'Blocked Drafts' },
    { id: 'runs', label: 'Run History' },
    { id: 'rejections', label: 'Rejection Log' },
  ];

  return (
    <div style={{ fontFamily: 'Plus Jakarta Sans, system-ui, sans-serif', background: '#08080A', color: '#E5E5E5', minHeight: '100vh', padding: '2rem' }}>
      <h1 style={{ color: '#F97316', marginBottom: '1.5rem' }}>UltraPlan Admin</h1>

      <nav style={{ display: 'flex', gap: '0.5rem', marginBottom: '2rem' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '0.5rem 1rem',
              background: tab === t.id ? '#F97316' : '#1A1A1C',
              color: tab === t.id ? '#08080A' : '#E5E5E5',
              border: '1px solid #333',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {loading && <p style={{ color: '#888' }}>Loading...</p>}
      {error && <p style={{ color: '#EF4444' }}>Error: {error}</p>}

      {!loading && tab === 'status' && (
        <div>
          <h2 style={{ marginBottom: '1rem' }}>Pipeline Status</h2>
          {runs.length === 0 ? (
            <p style={{ color: '#888' }}>No runs yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {runs.slice(0, 10).map((run) => (
                <div key={run.slug} style={{ background: '#1A1A1C', padding: '1rem', borderRadius: '8px', border: '1px solid #333' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{run.slug}</strong>
                    <span style={{ color: run.verdict === 'passed' ? '#22C55E' : run.verdict === 'blocked' ? '#EF4444' : '#F59E0B' }}>
                      {run.verdict}
                    </span>
                  </div>
                  <div style={{ color: '#888', fontSize: '0.875rem', marginTop: '0.25rem' }}>
                    {run.lane} · {run.created_at}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && tab === 'blocked' && (
        <div>
          <h2 style={{ marginBottom: '1rem' }}>Blocked Drafts</h2>
          {blocked.length === 0 ? (
            <p style={{ color: '#888' }}>No blocked drafts.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {blocked.map((draft) => (
                <div key={draft.slug} style={{ background: '#1A1A1C', padding: '1rem', borderRadius: '8px', border: '1px solid #EF4444' }}>
                  <strong>{draft.slug}</strong>
                  <p style={{ color: '#EF4444', margin: '0.5rem 0' }}>{draft.blocked_reason}</p>
                  <div style={{ fontSize: '0.875rem', color: '#888' }}>
                    {draft.lane} · {draft.created_at}
                  </div>
                  {draft.gate_report?.results && (
                    <div style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                      {draft.gate_report.results.map((g) => (
                        <span key={g.gate} style={{ marginRight: '1rem', color: g.passed ? '#22C55E' : '#EF4444' }}>
                          {g.gate}: {g.passed ? 'PASS' : 'FAIL'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && tab === 'runs' && (
        <div>
          <h2 style={{ marginBottom: '1rem' }}>Run History (last 100)</h2>
          {runs.length === 0 ? (
            <p style={{ color: '#888' }}>No runs yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #333', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem' }}>Slug</th>
                  <th style={{ padding: '0.5rem' }}>Lane</th>
                  <th style={{ padding: '0.5rem' }}>Verdict</th>
                  <th style={{ padding: '0.5rem' }}>Date</th>
                  <th style={{ padding: '0.5rem' }}>Override</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.slug} style={{ borderBottom: '1px solid #222' }}>
                    <td style={{ padding: '0.5rem' }}>{run.slug}</td>
                    <td style={{ padding: '0.5rem', color: '#888' }}>{run.lane}</td>
                    <td style={{ padding: '0.5rem', color: run.verdict === 'passed' ? '#22C55E' : '#EF4444' }}>{run.verdict}</td>
                    <td style={{ padding: '0.5rem', color: '#888' }}>{run.created_at}</td>
                    <td style={{ padding: '0.5rem' }}>{run.manual_override ? 'Yes' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!loading && tab === 'rejections' && (
        <div>
          <h2 style={{ marginBottom: '1rem' }}>Rejection Log</h2>
          {rejections.length === 0 ? (
            <p style={{ color: '#888' }}>No rejections yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {rejections.map((rej, i) => (
                <div key={`${rej.slug}-${i}`} style={{ background: '#1A1A1C', padding: '1rem', borderRadius: '8px', border: '1px solid #333' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <strong>{rej.slug}</strong>
                    <span style={{ color: '#888', fontSize: '0.875rem' }}>{rej.date}</span>
                  </div>
                  <p style={{ color: '#F59E0B', margin: '0.5rem 0' }}>{rej.reason}</p>
                  <div style={{ fontSize: '0.8rem', color: '#888' }}>
                    {rej.lane} · reviewed by {rej.reviewer}
                    {rej.pr_url && (
                      <> · <a href={rej.pr_url} style={{ color: '#F97316' }} target="_blank" rel="noopener noreferrer">PR</a></>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
