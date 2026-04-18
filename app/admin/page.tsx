'use client';

import { useState, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Admin dashboard — spec §8
// Five views: Pipeline status, Blocked drafts, PR queue, Run history,
// Rejection log. Basic auth handled by API routes.
// ---------------------------------------------------------------------------

type Tab = 'trigger' | 'status' | 'blocked' | 'runs' | 'rejections';

type Lane = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';
type Strategy = 'calendar_first' | 'feed_first' | 'curated_first';

// Curated buckets per lane — mirrors config/curated_sources.yaml. Keep in
// sync manually until we wire a /api/admin/buckets endpoint.
const BUCKETS_BY_LANE: Record<Lane, string[]> = {
  daily_seo: [
    'voice_ai_dealerships',
    'service_drive_fixed_ops',
    'digital_retail_friction',
    'speed_to_lead',
    'reputation_reviews',
    'used_car_price_spike',
  ],
  weekly_authority: ['leadership_lessons'],
  monthly_anonymized_case: ['client_wins'],
  listicle: [],
};

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
  const [tab, setTab] = useState<Tab>('trigger');
  const [runs, setRuns] = useState<Run[]>([]);
  const [blocked, setBlocked] = useState<BlockedDraft[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Trigger form state
  const [triggerLane, setTriggerLane] = useState<Lane>('daily_seo');
  const [triggerStrategy, setTriggerStrategy] = useState<Strategy>('curated_first');
  const [triggerBucket, setTriggerBucket] = useState<string>('');
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{ ok: boolean; message: string; actionsUrl?: string } | null>(null);

  useEffect(() => {
    loadData(tab);
  }, [tab]);

  async function loadData(activeTab: Tab) {
    // Trigger tab is pure form — no data to fetch, no auth prompt needed
    // until the user actually clicks submit.
    if (activeTab === 'trigger') return;
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

  async function submitTrigger() {
    setTriggering(true);
    setTriggerResult(null);
    try {
      const headers: HeadersInit = { ...authHeaders(), 'Content-Type': 'application/json' };
      const res = await fetch('/api/admin/trigger', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lane: triggerLane,
          strategy: triggerStrategy,
          curated_bucket: triggerStrategy === 'curated_first' ? triggerBucket : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTriggerResult({ ok: false, message: data.error ?? `HTTP ${res.status}` });
      } else {
        setTriggerResult({ ok: true, message: data.message, actionsUrl: data.actionsUrl });
      }
    } catch (err) {
      setTriggerResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTriggering(false);
    }
  }

  const availableBuckets = BUCKETS_BY_LANE[triggerLane] ?? [];
  const bucketRequired = triggerStrategy === 'curated_first' && availableBuckets.length > 0;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'trigger', label: 'New Run' },
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

      {tab === 'trigger' && (
        <div>
          <h2 style={{ marginBottom: '1rem' }}>New Pipeline Run</h2>
          <div style={{ background: '#1A1A1C', padding: '1.5rem', borderRadius: '8px', border: '1px solid #333', maxWidth: '520px', display: 'grid', gap: '1rem' }}>
            <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.875rem' }}>
              <span style={{ color: '#888', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.05em' }}>Lane</span>
              <select
                value={triggerLane}
                onChange={(e) => {
                  const next = e.target.value as Lane;
                  setTriggerLane(next);
                  const buckets = BUCKETS_BY_LANE[next] ?? [];
                  setTriggerBucket(buckets[0] ?? '');
                }}
                style={{ background: '#08080A', color: '#E5E5E5', border: '1px solid #333', borderRadius: '6px', padding: '0.5rem', fontFamily: 'inherit' }}
              >
                <option value="daily_seo">daily_seo — Industry Insights</option>
                <option value="weekly_authority">weekly_authority — Leadership</option>
                <option value="monthly_anonymized_case">monthly_anonymized_case — Case Studies</option>
                <option value="listicle">listicle — Guides & Roundups</option>
              </select>
            </label>

            <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.875rem' }}>
              <span style={{ color: '#888', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.05em' }}>Strategy</span>
              <select
                value={triggerStrategy}
                onChange={(e) => setTriggerStrategy(e.target.value as Strategy)}
                style={{ background: '#08080A', color: '#E5E5E5', border: '1px solid #333', borderRadius: '6px', padding: '0.5rem', fontFamily: 'inherit' }}
              >
                <option value="curated_first">curated_first — use a specific bucket</option>
                <option value="calendar_first">calendar_first — editorial calendar</option>
                <option value="feed_first">feed_first — latest news signal</option>
              </select>
            </label>

            {bucketRequired && (
              <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.875rem' }}>
                <span style={{ color: '#888', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.05em' }}>Curated bucket</span>
                <select
                  value={triggerBucket}
                  onChange={(e) => setTriggerBucket(e.target.value)}
                  style={{ background: '#08080A', color: '#E5E5E5', border: '1px solid #333', borderRadius: '6px', padding: '0.5rem', fontFamily: 'inherit' }}
                >
                  <option value="">— select bucket —</option>
                  {availableBuckets.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </label>
            )}

            <button
              onClick={submitTrigger}
              disabled={triggering || (bucketRequired && !triggerBucket)}
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem 1.25rem',
                background: triggering || (bucketRequired && !triggerBucket) ? '#333' : '#F97316',
                color: triggering || (bucketRequired && !triggerBucket) ? '#888' : '#08080A',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 700,
                fontSize: '0.9rem',
                cursor: triggering || (bucketRequired && !triggerBucket) ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {triggering ? 'Triggering…' : 'Trigger Run'}
            </button>

            {triggerResult && (
              <div
                style={{
                  marginTop: '0.5rem',
                  padding: '0.75rem 1rem',
                  background: triggerResult.ok ? '#052e16' : '#2e0505',
                  border: `1px solid ${triggerResult.ok ? '#22C55E' : '#EF4444'}`,
                  borderRadius: '6px',
                  color: triggerResult.ok ? '#bbf7d0' : '#fecaca',
                  fontSize: '0.875rem',
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
                  {triggerResult.ok ? '✓ Triggered' : '✗ Failed'}
                </div>
                <div>{triggerResult.message}</div>
                {triggerResult.actionsUrl && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <a
                      href={triggerResult.actionsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: '#F97316' }}
                    >
                      Open GitHub Actions →
                    </a>
                  </div>
                )}
              </div>
            )}

            <p style={{ color: '#666', fontSize: '0.75rem', marginTop: '0.5rem' }}>
              Replaces <code style={{ color: '#999' }}>gh workflow run daily-blog.yml</code>. Run appears in GitHub Actions within 2 seconds; status shows in the Pipeline Status tab once complete.
            </p>
          </div>
        </div>
      )}

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
