import { useEffect, useMemo, useState } from 'react';
import {
  CATEGORIES,
  CATEGORY_IDS,
  type Account,
  type AppState,
  type CategoryDiff,
  type CategoryId,
  type WriteResult,
} from '../shared/types';
import { api, categoryLabel, errorText, formatDate, keyCount } from './api';
import { DiffTable } from './DiffTable';
import { Confirm } from './Confirm';
import { CloudBadge } from './CloudBadge';

interface Props {
  state: AppState;
  version: number;
  onChanged: () => Promise<void>;
}

type Diffs = Record<string, CategoryDiff[] | { error: string }>;

function pickDefaultSource(accounts: Account[]): string {
  return (accounts.find((a) => a.changes.length > 0) ?? accounts[0]).id;
}

function Cell({ diff }: { diff: CategoryDiff | undefined }) {
  if (!diff) return <span className="muted">…</span>;
  const real = diff.files.filter((f) => f.status !== 'targetOnly');
  if (real.length === 0) return <span className="muted" title="The source has none of these files">no files</span>;
  if (!diff.changed) return <span className="cell-same">same</span>;
  const keys = keyCount(diff);
  const newFiles = diff.files.filter((f) => f.status === 'added').length;
  const parts = [keys > 0 ? `${keys} key${keys === 1 ? '' : 's'}` : null, newFiles > 0 ? `${newFiles} new file${newFiles === 1 ? '' : 's'}` : null].filter(Boolean);
  return <span className="cell-diff">{parts.join(', ') || 'differs'}</span>;
}

export function SyncView({ state, version, onChanged }: Props) {
  const { accounts } = state;
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const [source, setSource] = useState(() => pickDefaultSource(accounts));
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [cats, setCats] = useState<Set<CategoryId>>(() => new Set(CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id)));
  const [focus, setFocus] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Diffs>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openChange, setOpenChange] = useState<string | null>(null);

  // Keep the selection valid when the account list changes.
  useEffect(() => {
    if (!byId.has(source)) setSource(pickDefaultSource(accounts));
    setTargets((t) => new Set([...t].filter((id) => byId.has(id) && id !== source && byId.get(id)!.cloud !== 'on')));
    if (focus && (!byId.has(focus) || focus === source)) setFocus(null);
  }, [byId, accounts, source, focus]);

  // Load what a push from the source would change, for every other account.
  useEffect(() => {
    let cancelled = false;
    setDiffs({});
    (async () => {
      for (const a of accounts) {
        if (a.id === source) continue;
        let d: Diffs[string];
        try {
          d = await api.getDiff(source, a.id, [...CATEGORY_IDS]);
        } catch (e) {
          d = { error: errorText(e) };
        }
        if (cancelled) return;
        setDiffs((prev) => ({ ...prev, [a.id]: d }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, accounts, version]);

  const others = accounts.filter((a) => a.id !== source);
  const focused = focus ?? [...targets][0] ?? others[0]?.id ?? null;
  const selectedCats = CATEGORY_IDS.filter((c) => cats.has(c));
  const changedAccounts = accounts.filter((a) => a.changes.length > 0);

  const diffFor = (id: string, cat: CategoryId): CategoryDiff | undefined => {
    const d = diffs[id];
    return d && !('error' in d) ? d.find((x) => x.category === cat) : undefined;
  };

  const pushSummary = [...targets].map((t) => {
    const changed = selectedCats.map((c) => diffFor(t, c)).filter((d): d is CategoryDiff => !!d && d.changed);
    return { id: t, changed, keys: changed.reduce((n, d) => n + keyCount(d), 0) };
  });
  const nothingToPush = pushSummary.length > 0 && pushSummary.every((s) => s.changed.length === 0);

  const blocker = state.dotaRunning
    ? 'Close Dota 2 to push.'
    : targets.size === 0
      ? 'Pick one or more target accounts.'
      : selectedCats.length === 0
        ? 'Pick at least one category.'
        : nothingToPush
          ? 'The targets already match the source.'
          : null;

  const toggleTarget = (id: string) =>
    setTargets((t) => {
      const n = new Set(t);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleCat = (id: CategoryId) =>
    setCats((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const doPush = async () => {
    setConfirming(false);
    setBusy(true);
    setActionError(null);
    setResult(null);
    try {
      setResult(await api.push(source, [...targets], selectedCats));
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  const focusedDiff = focused ? diffs[focused] : undefined;
  const sourceName = byId.get(source)?.name ?? source;

  return (
    <div className="sync">
      <section className="card">
        <h2>
          Changed since last check
          {state.lastCheck && <span className="muted small"> · {formatDate(state.lastCheck)}</span>}
        </h2>
        {!state.lastCheck ? (
          <p className="muted">First check: a snapshot of every account was saved. Changes show up here the next time you open the app.</p>
        ) : changedAccounts.length === 0 ? (
          <p className="muted">No account changed since the last check.</p>
        ) : (
          <ul className="changes">
            {changedAccounts.map((a) => (
              <li key={a.id}>
                <div className="change-row">
                  <button className="link" onClick={() => setOpenChange(openChange === a.id ? null : a.id)}>
                    {openChange === a.id ? '▾' : '▸'} <strong>{a.name}</strong>
                  </button>
                  <span className="muted small">
                    {a.changes.map((c) => `${categoryLabel(c.category)} (${keyCount(c) || c.files.length})`).join(' · ')}
                  </span>
                  {a.id !== source && (
                    <button className="small-btn" onClick={() => setSource(a.id)}>
                      Use as source
                    </button>
                  )}
                </div>
                {openChange === a.id &&
                  a.changes.map((c) => (
                    <div key={c.category} className="change-detail">
                      <h4>{categoryLabel(c.category)}</h4>
                      <DiffTable files={c.files} beforeLabel="Last check" afterLabel="Now" mode="check" />
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        )}
        {accounts.some((a) => a.firstSeen) && state.lastCheck && (
          <p className="muted small">
            New since last check: {accounts.filter((a) => a.firstSeen).map((a) => a.name).join(', ')}
          </p>
        )}
      </section>

      <section className="card">
        <h2>Accounts</h2>
        <div className="grid-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th className="col-role">Source</th>
                <th className="col-role">Target</th>
                <th>Account</th>
                {CATEGORIES.map((c) => (
                  <th key={c.id} className="col-cat">
                    <label title={c.patterns.join('\n')}>
                      <input type="checkbox" checked={cats.has(c.id)} onChange={() => toggleCat(c.id)} /> {c.label}
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const isSource = a.id === source;
                const d = diffs[a.id];
                const blocked = a.cloud === 'on';
                return (
                  <tr
                    key={a.id}
                    className={[isSource ? 'is-source' : '', !isSource && focused === a.id ? 'is-focus' : ''].join(' ')}
                    onClick={() => !isSource && setFocus(a.id)}
                  >
                    <td className="col-role">
                      <input
                        type="radio"
                        name="source"
                        checked={isSource}
                        onChange={() => {
                          setSource(a.id);
                          setResult(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Use ${a.name} as source`}
                      />
                    </td>
                    <td className="col-role">
                      <input
                        type="checkbox"
                        checked={targets.has(a.id)}
                        disabled={isSource || blocked}
                        title={blocked ? 'Steam Cloud is on for this account' : isSource ? 'This is the source' : ''}
                        onChange={() => toggleTarget(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Push to ${a.name}`}
                      />
                    </td>
                    <td className="account">
                      <div className="account-name">
                        {a.name}
                        {a.changes.length > 0 && <span className="dot" title="Changed since last check" />}
                      </div>
                      <div className="muted small">{a.id}</div>
                      <CloudBadge account={a} />
                    </td>
                    {CATEGORIES.map((c) => (
                      <td key={c.id} className={`col-cat ${cats.has(c.id) ? '' : 'off'}`}>
                        {isSource ? (
                          <span className="muted">source</span>
                        ) : d && 'error' in d ? (
                          <span className="error small" title={d.error}>
                            error
                          </span>
                        ) : (
                          <Cell diff={diffFor(a.id, c.id)} />
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">Cells show what a push from {sourceName} would change. Click a row to see it key by key.</p>
      </section>

      {focused && (
        <section className="card">
          <h2>
            {sourceName} → {byId.get(focused)?.name}
          </h2>
          {!focusedDiff ? (
            <p className="muted">Comparing…</p>
          ) : 'error' in focusedDiff ? (
            <p className="error">{focusedDiff.error}</p>
          ) : selectedCats.length === 0 ? (
            <p className="muted">Pick a category to compare.</p>
          ) : (
            focusedDiff
              .filter((d) => cats.has(d.category))
              .map((d) => (
                <div key={d.category} className="cat-diff">
                  <h3>
                    {categoryLabel(d.category)}{' '}
                    <span className="muted small">{d.changed ? (keyCount(d) === 1 ? '1 key differs' : `${keyCount(d)} keys differ`) : 'already the same'}</span>
                  </h3>
                  {d.changed || d.files.some((f) => f.status === 'targetOnly') ? (
                    <DiffTable
                      files={d.files}
                      beforeLabel={`${byId.get(focused)?.name ?? 'Target'} now`}
                      afterLabel="After push"
                      mode="push"
                    />
                  ) : null}
                </div>
              ))
          )}
        </section>
      )}

      <div className="pushbar">
        <div className="pushbar-text">
          {result ? (
            <PushResultView result={result} names={byId} />
          ) : actionError ? (
            <span className="error">{actionError}</span>
          ) : blocker ? (
            <span className="muted">{blocker}</span>
          ) : (
            <span>
              Push <strong>{selectedCats.map(categoryLabel).join(', ')}</strong> from <strong>{sourceName}</strong> to{' '}
              <strong>{[...targets].map((t) => byId.get(t)?.name).join(', ')}</strong>
            </span>
          )}
        </div>
        {result && (
          <button className="small-btn" onClick={() => setResult(null)}>
            Dismiss
          </button>
        )}
        <button className="primary" disabled={!!blocker || busy} onClick={() => setConfirming(true)}>
          {busy ? 'Pushing…' : 'Push'}
        </button>
      </div>

      {confirming && (
        <Confirm
          title="Push these changes?"
          confirmLabel="Push"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doPush()}
        >
          <p>
            From <strong>{sourceName}</strong>: {selectedCats.map(categoryLabel).join(', ')}
          </p>
          <ul>
            {pushSummary.map((s) => (
              <li key={s.id}>
                <strong>{byId.get(s.id)?.name}</strong>:{' '}
                {s.changed.length === 0
                  ? 'already the same (files are rewritten anyway)'
                  : `${s.changed.map((d) => categoryLabel(d.category)).join(', ')} · ${s.keys} keys`}
              </li>
            ))}
          </ul>
          <p className="muted small">Each target's current files are zipped to a backup first. You can restore it from the Backups tab.</p>
        </Confirm>
      )}
    </div>
  );
}

function PushResultView({ result, names }: { result: WriteResult; names: Map<string, Account> }) {
  if (result.error) return <span className="error">{result.error}</span>;
  return (
    <span>
      {result.results.map((r) => (
        <span key={r.accountId} className={r.ok ? 'ok' : 'error'}>
          {names.get(r.accountId)?.name ?? r.accountId}:{' '}
          {r.ok ? `${r.filesWritten} files written` : `${r.error}${r.rolledBack ? ' (rolled back)' : ''}`}
          {'  '}
        </span>
      ))}
    </span>
  );
}
