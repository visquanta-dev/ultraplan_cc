'use client';

import { useState, useEffect, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Admin dashboard — editorial-brutalist aesthetic
// Design direction: MIT Technology Review meets terminal operator.
// Fraunces serif display, Plus Jakarta body, JetBrains Mono for all data.
// Orange used as ink, not decoration.
// ---------------------------------------------------------------------------

type Tab = 'trigger' | 'status' | 'blocked' | 'runs' | 'rejections';
type Lane = 'daily_seo' | 'weekly_authority' | 'monthly_anonymized_case' | 'listicle';
type Strategy = 'calendar_first' | 'feed_first' | 'curated_first';

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

const LANE_DESCRIPTIONS: Record<Lane, string> = {
  daily_seo: 'Industry Insights',
  weekly_authority: 'Leadership',
  monthly_anonymized_case: 'Case Studies',
  listicle: 'Guides & Roundups',
};

const STRATEGY_DESCRIPTIONS: Record<Strategy, string> = {
  curated_first: 'Specific bucket',
  calendar_first: 'Editorial calendar',
  feed_first: 'Latest news signal',
};

function getAuthHeaders(): HeadersInit {
  const user = prompt('Admin username:') ?? '';
  const pass = prompt('Admin password:') ?? '';
  return { Authorization: `Basic ${btoa(`${user}:${pass}`)}` };
}

let cachedHeaders: HeadersInit | null = null;
function authHeaders(): HeadersInit {
  if (!cachedHeaders) cachedHeaders = getAuthHeaders();
  return cachedHeaders;
}

// Noise texture as inline SVG data URI — adds subtle print-grain atmosphere
const NOISE_BG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.04 0'/></filter><rect width='240' height='240' filter='url(%23n)'/></svg>\")";

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    return `${days}d`;
  } catch {
    return iso;
  }
}

function verdictStyle(verdict: string): { label: string; colorClass: string } {
  if (verdict === 'passed' || verdict === 'published') {
    return { label: verdict, colorClass: 'text-emerald-400 ring-emerald-500/30' };
  }
  if (verdict === 'blocked' || verdict === 'failed') {
    return { label: verdict, colorClass: 'text-red-400 ring-red-500/40' };
  }
  return { label: verdict, colorClass: 'text-amber-400 ring-amber-500/30' };
}

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('trigger');
  const [runs, setRuns] = useState<Run[]>([]);
  const [blocked, setBlocked] = useState<BlockedDraft[]>([]);
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [triggerLane, setTriggerLane] = useState<Lane>('daily_seo');
  const [triggerStrategy, setTriggerStrategy] = useState<Strategy>('curated_first');
  const [triggerBucket, setTriggerBucket] = useState<string>('');
  const [triggering, setTriggering] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{
    ok: boolean;
    message: string;
    actionsUrl?: string;
  } | null>(null);

  useEffect(() => {
    loadData(tab);
    if (tab === 'trigger') void loadRunsQuiet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function loadRunsQuiet() {
    try {
      const headers = authHeaders();
      const res = await fetch('/api/admin/runs', { headers });
      if (!res.ok) return;
      const data = await res.json();
      setRuns(data.runs ?? []);
    } catch {
      // Silent — main tab surfaces auth errors
    }
  }

  async function loadData(activeTab: Tab) {
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
      cachedHeaders = null;
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
        setTimeout(() => void loadRunsQuiet(), 2500);
      }
    } catch (err) {
      setTriggerResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTriggering(false);
    }
  }

  const availableBuckets = BUCKETS_BY_LANE[triggerLane] ?? [];
  const bucketRequired = triggerStrategy === 'curated_first' && availableBuckets.length > 0;
  const recentRuns = useMemo(() => runs.slice(0, 6), [runs]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'trigger', label: 'New Run' },
    { id: 'status', label: 'Pipeline Status' },
    { id: 'blocked', label: 'Blocked Drafts' },
    { id: 'runs', label: 'Run History' },
    { id: 'rejections', label: 'Rejection Log' },
  ];

  const today = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).toUpperCase();
  }, []);

  return (
    <div
      className="min-h-screen bg-[#08080A] text-zinc-200"
      style={{
        fontFamily: 'var(--font-body), system-ui, sans-serif',
        backgroundImage: NOISE_BG,
        backgroundRepeat: 'repeat',
      }}
    >
      {/* Masthead */}
      <header className="border-b border-zinc-900">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-8 py-4 md:px-12">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span
                className="block h-2 w-2"
                style={{ background: '#F97316' }}
                aria-hidden
              />
              <span
                className="text-[10px] uppercase tracking-[0.25em] text-zinc-400"
                style={{ fontFamily: 'var(--font-mono), monospace' }}
              >
                UltraPlan · Admin
              </span>
            </div>
          </div>
          <div
            className="hidden items-center gap-6 text-[10px] uppercase tracking-[0.2em] text-zinc-500 md:flex"
            style={{ fontFamily: 'var(--font-mono), monospace' }}
          >
            <span>
              Vol. I <span className="text-zinc-700">/</span> Iss. 04
            </span>
            <span className="text-zinc-700">·</span>
            <span>{today}</span>
            <span className="text-zinc-700">·</span>
            <span className="text-emerald-400">● Production</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-8 pt-14 pb-20 md:px-12">
        {/* Title block */}
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-9">
            <p
              className="text-[10px] uppercase tracking-[0.3em] text-zinc-500"
              style={{ fontFamily: 'var(--font-mono), monospace' }}
            >
              § Control Room
            </p>
            <h1
              className="mt-3 text-[56px] leading-[0.95] tracking-[-0.02em] text-zinc-50 md:text-[76px]"
              style={{
                fontFamily: 'var(--font-display), Georgia, serif',
                fontWeight: 400,
                fontVariationSettings: '"opsz" 144, "SOFT" 50, "WONK" 0',
              }}
            >
              Dashboard.
            </h1>
            <div
              className="mt-6 h-[3px] w-20"
              style={{ background: '#F97316' }}
              aria-hidden
            />
            <p className="mt-6 max-w-xl text-[15px] leading-[1.55] text-zinc-400">
              Trigger pipeline runs, review blocked drafts, and audit the quality-gate history
              for the visquanta.com editorial pipeline. Five tabs, one page, no terminal.
            </p>
          </div>
          <div className="col-span-12 hidden lg:col-span-3 lg:block">
            <div
              className="border-l border-zinc-800 pl-6 text-[11px] leading-[1.7] text-zinc-500"
              style={{ fontFamily: 'var(--font-mono), monospace' }}
            >
              <p className="mb-1 uppercase tracking-[0.2em] text-zinc-600">Masthead</p>
              <p>Editor: <span className="text-zinc-300">W. Voyles</span></p>
              <p>Engine: <span className="text-zinc-300">UltraPlan v2</span></p>
              <p>Model: <span className="text-zinc-300">claude-opus-4-7</span></p>
              <p>Frequency: <span className="text-zinc-300">5 posts / week</span></p>
            </div>
          </div>
        </div>

        {/* Nav + Content grid */}
        <div className="mt-14 grid grid-cols-12 gap-8">
          {/* Sidebar nav */}
          <nav className="col-span-12 lg:col-span-3">
            <p
              className="mb-4 border-b border-zinc-900 pb-3 text-[10px] uppercase tracking-[0.25em] text-zinc-500"
              style={{ fontFamily: 'var(--font-mono), monospace' }}
            >
              Contents
            </p>
            <ul className="grid gap-px">
              {tabs.map((t, i) => {
                const active = tab === t.id;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => setTab(t.id)}
                      className={`group flex w-full items-baseline gap-4 border-l-2 py-3 pl-4 pr-2 text-left transition ${
                        active
                          ? 'border-[#F97316] bg-zinc-950/40'
                          : 'border-transparent hover:border-zinc-700 hover:bg-zinc-950/30'
                      }`}
                    >
                      <span
                        className={`text-[10px] tracking-[0.2em] ${
                          active ? 'text-[#F97316]' : 'text-zinc-600'
                        }`}
                        style={{ fontFamily: 'var(--font-mono), monospace' }}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span
                        className={`text-[15px] ${
                          active ? 'text-zinc-50' : 'text-zinc-400 group-hover:text-zinc-200'
                        }`}
                      >
                        {t.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div
              className="mt-10 border-t border-zinc-900 pt-4 text-[11px] leading-[1.6] text-zinc-600"
              style={{ fontFamily: 'var(--font-mono), monospace' }}
            >
              <p className="mb-2 uppercase tracking-[0.2em] text-zinc-600">Colophon</p>
              <p>
                Each run opens a PR on
                <br />
                <span className="text-zinc-400">visquanta-dev/site</span>.
              </p>
              <p className="mt-2">
                Human review required
                <br />
                before merge.
              </p>
            </div>
          </nav>

          {/* Main content */}
          <main className="col-span-12 lg:col-span-9">
            {loading && (
              <p
                className="text-[11px] uppercase tracking-[0.2em] text-zinc-500"
                style={{ fontFamily: 'var(--font-mono), monospace' }}
              >
                Loading…
              </p>
            )}
            {error && (
              <div
                className="mb-6 border border-red-500/30 bg-red-950/20 px-5 py-4 text-sm text-red-300"
                style={{ fontFamily: 'var(--font-body), system-ui, sans-serif' }}
              >
                <p
                  className="mb-1 text-[10px] uppercase tracking-[0.25em] text-red-400"
                  style={{ fontFamily: 'var(--font-mono), monospace' }}
                >
                  Error
                </p>
                {error}
              </div>
            )}

            {/* ──────────────── NEW RUN ──────────────── */}
            {tab === 'trigger' && (
              <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
                {/* Trigger form — article-style layout */}
                <section>
                  <div className="flex items-baseline gap-3">
                    <h2
                      className="text-[36px] leading-[1] tracking-tight text-zinc-50"
                      style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                    >
                      New pipeline run.
                    </h2>
                  </div>
                  <p
                    className="mt-3 max-w-md text-[13px] text-zinc-500"
                    style={{ fontFamily: 'var(--font-mono), monospace' }}
                  >
                    ¶ Replaces{' '}
                    <span className="text-zinc-300">gh workflow run daily-blog.yml</span>.
                    Run appears in GitHub Actions within ~2 seconds.
                  </p>

                  <div className="mt-8 border border-zinc-900 bg-[#0C0C10]">
                    <div className="grid gap-6 p-7">
                      <FieldRow label="Lane" num="01">
                        <select
                          value={triggerLane}
                          onChange={(e) => {
                            const next = e.target.value as Lane;
                            setTriggerLane(next);
                            const buckets = BUCKETS_BY_LANE[next] ?? [];
                            setTriggerBucket(buckets[0] ?? '');
                          }}
                          className="w-full appearance-none border border-zinc-800 bg-black px-3 py-2.5 text-[14px] text-zinc-100 outline-none transition focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]/40"
                        >
                          {(Object.keys(LANE_DESCRIPTIONS) as Lane[]).map((l) => (
                            <option key={l} value={l}>
                              {l} — {LANE_DESCRIPTIONS[l]}
                            </option>
                          ))}
                        </select>
                      </FieldRow>

                      <FieldRow label="Strategy" num="02">
                        <select
                          value={triggerStrategy}
                          onChange={(e) => setTriggerStrategy(e.target.value as Strategy)}
                          className="w-full appearance-none border border-zinc-800 bg-black px-3 py-2.5 text-[14px] text-zinc-100 outline-none transition focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]/40"
                        >
                          {(Object.keys(STRATEGY_DESCRIPTIONS) as Strategy[]).map((s) => (
                            <option key={s} value={s}>
                              {s} — {STRATEGY_DESCRIPTIONS[s]}
                            </option>
                          ))}
                        </select>
                      </FieldRow>

                      {bucketRequired && (
                        <FieldRow label="Curated bucket" num="03">
                          <select
                            value={triggerBucket}
                            onChange={(e) => setTriggerBucket(e.target.value)}
                            className="w-full appearance-none border border-zinc-800 bg-black px-3 py-2.5 text-[14px] text-zinc-100 outline-none transition focus:border-[#F97316] focus:ring-1 focus:ring-[#F97316]/40"
                          >
                            <option value="">— select bucket —</option>
                            {availableBuckets.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        </FieldRow>
                      )}

                      <div className="pt-2">
                        <button
                          onClick={submitTrigger}
                          disabled={triggering || (bucketRequired && !triggerBucket)}
                          className="group relative flex w-full items-center justify-between gap-3 px-6 py-4 text-[13px] font-semibold uppercase tracking-[0.2em] text-black transition disabled:cursor-not-allowed"
                          style={{
                            background:
                              triggering || (bucketRequired && !triggerBucket)
                                ? '#1a1a20'
                                : '#F97316',
                            color:
                              triggering || (bucketRequired && !triggerBucket) ? '#52525b' : '#08080A',
                            fontFamily: 'var(--font-mono), monospace',
                          }}
                        >
                          <span>{triggering ? 'Triggering…' : 'Trigger run'}</span>
                          <span aria-hidden className="text-lg">
                            {triggering ? '·' : '→'}
                          </span>
                        </button>
                      </div>

                      {triggerResult && (
                        <div
                          className={`border px-5 py-4 ${
                            triggerResult.ok
                              ? 'border-emerald-500/30 bg-emerald-950/20'
                              : 'border-red-500/30 bg-red-950/20'
                          }`}
                        >
                          <p
                            className={`text-[10px] uppercase tracking-[0.25em] ${
                              triggerResult.ok ? 'text-emerald-400' : 'text-red-400'
                            }`}
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            {triggerResult.ok ? '● Triggered' : '✗ Failed'}
                          </p>
                          <p className="mt-1 text-[14px] text-zinc-300">{triggerResult.message}</p>
                          {triggerResult.actionsUrl && (
                            <a
                              href={triggerResult.actionsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-3 inline-flex items-center gap-1.5 text-[12px] uppercase tracking-[0.18em] text-[#F97316] transition hover:text-[#FFA45C]"
                              style={{ fontFamily: 'var(--font-mono), monospace' }}
                            >
                              Open GitHub Actions <span aria-hidden>→</span>
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                {/* Recent runs side panel */}
                <aside>
                  <div className="flex items-baseline justify-between">
                    <h3
                      className="text-[22px] leading-[1] tracking-tight text-zinc-50"
                      style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                    >
                      Recent runs.
                    </h3>
                    <button
                      onClick={() => void loadRunsQuiet()}
                      className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 transition hover:text-zinc-300"
                      style={{ fontFamily: 'var(--font-mono), monospace' }}
                    >
                      ↻ Refresh
                    </button>
                  </div>
                  <div className="mt-2 h-px w-8 bg-[#F97316]" aria-hidden />

                  <div className="mt-6 grid gap-px bg-zinc-900">
                    {recentRuns.length === 0 ? (
                      <p
                        className="bg-[#0C0C10] px-4 py-5 text-[13px] text-zinc-500"
                        style={{ fontFamily: 'var(--font-mono), monospace' }}
                      >
                        No runs yet.
                      </p>
                    ) : (
                      recentRuns.map((run) => {
                        const v = verdictStyle(run.verdict);
                        return (
                          <div
                            key={`${run.slug}-${run.created_at}`}
                            className="bg-[#0C0C10] px-4 py-3 transition hover:bg-[#101016]"
                          >
                            <div className="flex items-baseline justify-between gap-3">
                              <span
                                className="truncate text-[13px] text-zinc-200"
                                title={run.slug}
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {run.slug}
                              </span>
                              <span
                                className={`ml-auto shrink-0 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.18em] ring-1 ring-inset ${v.colorClass}`}
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {v.label}
                              </span>
                            </div>
                            <div
                              className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-zinc-600"
                              style={{ fontFamily: 'var(--font-mono), monospace' }}
                            >
                              <span>{run.lane}</span>
                              <span>·</span>
                              <span>{formatRelative(run.created_at)}</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </aside>
              </div>
            )}

            {/* ──────────────── PIPELINE STATUS ──────────────── */}
            {!loading && tab === 'status' && (
              <div>
                <h2
                  className="text-[36px] leading-[1] tracking-tight text-zinc-50"
                  style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                >
                  Pipeline status.
                </h2>
                <div className="mt-2 h-px w-8 bg-[#F97316]" aria-hidden />
                <p className="mt-4 text-[13px] text-zinc-500">Last 10 runs from Vercel Blob storage.</p>

                {runs.length === 0 ? (
                  <p
                    className="mt-8 text-[13px] text-zinc-500"
                    style={{ fontFamily: 'var(--font-mono), monospace' }}
                  >
                    No runs yet.
                  </p>
                ) : (
                  <div className="mt-8 grid gap-px bg-zinc-900">
                    {runs.slice(0, 10).map((run) => {
                      const v = verdictStyle(run.verdict);
                      return (
                        <div
                          key={`${run.slug}-${run.created_at}`}
                          className="bg-[#0C0C10] px-6 py-5 transition hover:bg-[#101016]"
                        >
                          <div className="flex items-baseline justify-between gap-4">
                            <span
                              className="text-[16px] text-zinc-100"
                              style={{ fontFamily: 'var(--font-mono), monospace' }}
                            >
                              {run.slug}
                            </span>
                            <span
                              className={`shrink-0 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ring-1 ring-inset ${v.colorClass}`}
                              style={{ fontFamily: 'var(--font-mono), monospace' }}
                            >
                              {v.label}
                            </span>
                          </div>
                          <div
                            className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-600"
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            <span>{run.lane}</span>
                            <span>·</span>
                            <span>{formatRelative(run.created_at)} ago</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ──────────────── BLOCKED DRAFTS ──────────────── */}
            {!loading && tab === 'blocked' && (
              <div>
                <h2
                  className="text-[36px] leading-[1] tracking-tight text-zinc-50"
                  style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                >
                  Blocked drafts.
                </h2>
                <div className="mt-2 h-px w-8 bg-[#F97316]" aria-hidden />
                <p className="mt-4 text-[13px] text-zinc-500">
                  Drafts that failed the quality-gate stack and did not ship.
                </p>

                {blocked.length === 0 ? (
                  <p
                    className="mt-8 text-[13px] text-zinc-500"
                    style={{ fontFamily: 'var(--font-mono), monospace' }}
                  >
                    No blocked drafts.
                  </p>
                ) : (
                  <div className="mt-8 grid gap-6">
                    {blocked.map((draft) => (
                      <div
                        key={`${draft.slug}-${draft.created_at}`}
                        className="border border-red-500/30 bg-red-950/10 p-6"
                      >
                        <div className="flex items-baseline justify-between gap-4">
                          <span
                            className="text-[17px] text-zinc-100"
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            {draft.slug}
                          </span>
                          <span
                            className="shrink-0 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-red-400 ring-1 ring-inset ring-red-500/40"
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            Blocked
                          </span>
                        </div>
                        <p className="mt-3 text-[14px] leading-[1.6] text-red-300">
                          {draft.blocked_reason}
                        </p>
                        <div
                          className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500"
                          style={{ fontFamily: 'var(--font-mono), monospace' }}
                        >
                          <span>{draft.lane}</span>
                          <span>·</span>
                          <span>{formatRelative(draft.created_at)} ago</span>
                        </div>
                        {draft.gate_report?.results && (
                          <div className="mt-5 flex flex-wrap gap-2">
                            {draft.gate_report.results.map((g) => (
                              <span
                                key={g.gate}
                                className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ring-1 ring-inset ${
                                  g.passed
                                    ? 'text-emerald-400 ring-emerald-500/30'
                                    : 'text-red-400 ring-red-500/40'
                                }`}
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {g.gate}: {g.passed ? 'pass' : 'fail'}
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

            {/* ──────────────── RUN HISTORY ──────────────── */}
            {!loading && tab === 'runs' && (
              <div>
                <h2
                  className="text-[36px] leading-[1] tracking-tight text-zinc-50"
                  style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                >
                  Run history.
                </h2>
                <div className="mt-2 h-px w-8 bg-[#F97316]" aria-hidden />
                <p className="mt-4 text-[13px] text-zinc-500">Last 100 runs from blob storage.</p>

                {runs.length === 0 ? (
                  <p
                    className="mt-8 text-[13px] text-zinc-500"
                    style={{ fontFamily: 'var(--font-mono), monospace' }}
                  >
                    No runs yet.
                  </p>
                ) : (
                  <div className="mt-8 overflow-hidden border border-zinc-900">
                    <table className="w-full">
                      <thead>
                        <tr
                          className="border-b border-zinc-900 bg-[#0C0C10] text-left text-[10px] uppercase tracking-[0.22em] text-zinc-500"
                          style={{ fontFamily: 'var(--font-mono), monospace' }}
                        >
                          <th className="px-5 py-4 font-normal">Slug</th>
                          <th className="px-5 py-4 font-normal">Lane</th>
                          <th className="px-5 py-4 font-normal">Verdict</th>
                          <th className="px-5 py-4 font-normal">Date</th>
                          <th className="px-5 py-4 font-normal">Override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((run) => {
                          const v = verdictStyle(run.verdict);
                          return (
                            <tr
                              key={`${run.slug}-${run.created_at}`}
                              className="border-b border-zinc-900 last:border-b-0 transition hover:bg-[#101016]"
                            >
                              <td
                                className="px-5 py-4 text-[13px] text-zinc-200"
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {run.slug}
                              </td>
                              <td
                                className="px-5 py-4 text-[12px] text-zinc-500"
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {run.lane}
                              </td>
                              <td className="px-5 py-4">
                                <span
                                  className={`px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ring-1 ring-inset ${v.colorClass}`}
                                  style={{ fontFamily: 'var(--font-mono), monospace' }}
                                >
                                  {v.label}
                                </span>
                              </td>
                              <td
                                className="px-5 py-4 text-[12px] text-zinc-500"
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {formatRelative(run.created_at)} ago
                              </td>
                              <td
                                className="px-5 py-4 text-[12px] text-zinc-500"
                                style={{ fontFamily: 'var(--font-mono), monospace' }}
                              >
                                {run.manual_override ? 'Yes' : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* ──────────────── REJECTIONS ──────────────── */}
            {!loading && tab === 'rejections' && (
              <div>
                <h2
                  className="text-[36px] leading-[1] tracking-tight text-zinc-50"
                  style={{ fontFamily: 'var(--font-display), Georgia, serif', fontWeight: 400 }}
                >
                  Rejection log.
                </h2>
                <div className="mt-2 h-px w-8 bg-[#F97316]" aria-hidden />
                <p className="mt-4 text-[13px] text-zinc-500">
                  Drafts a reviewer rejected after the pipeline opened a PR.
                </p>

                {rejections.length === 0 ? (
                  <p
                    className="mt-8 text-[13px] text-zinc-500"
                    style={{ fontFamily: 'var(--font-mono), monospace' }}
                  >
                    No rejections yet.
                  </p>
                ) : (
                  <div className="mt-8 grid gap-6">
                    {rejections.map((rej, i) => (
                      <div
                        key={`${rej.slug}-${i}`}
                        className="border border-zinc-900 bg-[#0C0C10] p-6"
                      >
                        <div className="flex items-baseline justify-between gap-4">
                          <span
                            className="text-[17px] text-zinc-100"
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            {rej.slug}
                          </span>
                          <span
                            className="text-[11px] uppercase tracking-[0.2em] text-zinc-500"
                            style={{ fontFamily: 'var(--font-mono), monospace' }}
                          >
                            {rej.date}
                          </span>
                        </div>
                        <p className="mt-3 text-[14px] leading-[1.6] text-amber-300">{rej.reason}</p>
                        <div
                          className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500"
                          style={{ fontFamily: 'var(--font-mono), monospace' }}
                        >
                          <span>{rej.lane}</span>
                          <span>·</span>
                          <span>reviewed by {rej.reviewer}</span>
                          {rej.pr_url && (
                            <>
                              <span>·</span>
                              <a
                                href={rej.pr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#F97316] transition hover:text-[#FFA45C]"
                              >
                                PR →
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Foot */}
      <footer
        className="mt-16 border-t border-zinc-900"
        style={{ fontFamily: 'var(--font-mono), monospace' }}
      >
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-8 py-5 text-[10px] uppercase tracking-[0.22em] text-zinc-600 md:px-12">
          <span>© VisQuanta · UltraPlan Engine</span>
          <span className="hidden md:inline">
            Dashboard.tsx · /admin · Build: {new Date().toISOString().slice(0, 10)}
          </span>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FieldRow({
  label,
  num,
  children,
}: {
  label: string;
  num: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2">
      <span
        className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-zinc-500"
        style={{ fontFamily: 'var(--font-mono), monospace' }}
      >
        <span className="text-zinc-700">{num}</span>
        <span className="h-px flex-shrink-0 w-4 bg-zinc-800" aria-hidden />
        <span>{label}</span>
      </span>
      {children}
    </label>
  );
}
