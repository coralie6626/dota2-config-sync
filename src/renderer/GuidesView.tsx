import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppState,
  GuideImportResult,
  GuideProgress,
  GuideToolStatus,
} from '../shared/types';
import { api, errorText } from './api';
import { Confirm } from './Confirm';
import { CloudBadge } from './CloudBadge';

interface Props {
  state: AppState;
  onChanged: () => Promise<void>;
}

export function GuidesView({ state, onChanged }: Props) {
  const { accounts } = state;
  const byId = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  const [tool, setTool] = useState<GuideToolStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [replace, setReplace] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GuideProgress | null>(null);
  const [result, setResult] = useState<GuideImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkTool = useCallback(async () => {
    setChecking(true);
    try {
      setTool(await api.guideToolStatus());
    } catch (e) {
      setTool({
        ok: false,
        python: null,
        toolVersion: null,
        installHint: '',
        error: errorText(e),
      });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkTool();
  }, [checkTool]);

  useEffect(() => api.onGuideProgress(setProgress), []);

  // Drop targets that disappeared or can't be written.
  useEffect(() => {
    setTargets(
      (t) =>
        new Set(
          [...t].filter((id) => byId.has(id) && byId.get(id)!.cloud !== 'on'),
        ),
    );
  }, [byId]);

  const writable = accounts.filter((a) => a.cloud !== 'on');
  const toggle = (id: string) =>
    setTargets((t) => {
      const n = new Set(t);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked =
    writable.length > 0 && writable.every((a) => targets.has(a.id));

  const blocker = !tool
    ? 'Checking for d2pt-guides…'
    : !tool.ok
      ? 'Install d2pt-guides first.'
      : state.dotaRunning
        ? 'Close Dota 2 to import guides.'
        : targets.size === 0
          ? 'Pick one or more accounts.'
          : null;

  const doImport = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      setResult(await api.importGuides([...targets], { replace }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProgress(null);
      await onChanged();
    }
  };

  const pct =
    progress && progress.total > 0
      ? Math.round((100 * progress.done) / progress.total)
      : 0;

  return (
    <div className="sync">
      <section className="card">
        <h2>D2PT hero guides</h2>
        <p>
          Generates an in-game guide for every hero and position from the most
          played builds on{' '}
          <a
            href="https://dota2protracker.com"
            target="_blank"
            rel="noreferrer"
          >
            Dota2ProTracker
          </a>{' '}
          (7000+ MMR pubs, last ~8 days), using{' '}
          <a
            href="https://github.com/Darktex/d2pt-guides"
            target="_blank"
            rel="noreferrer"
          >
            d2pt-guides
          </a>
          , and installs them into the accounts you pick.
        </p>
        <p className="muted small">
          All build data is Dota2ProTracker's work. Generating every hero takes
          about 8 minutes (the tool caches D2PT's answers for 30 minutes, so a
          re-run soon after is quick). Start Dota 2 after the import: it only
          loads guides when it starts.
        </p>
        <div className="tool-status">
          {!tool ? (
            <span className="muted">Checking for Python and d2pt-guides…</span>
          ) : tool.ok ? (
            <span className="ok">
              d2pt-guides {tool.toolVersion} found (Python {tool.python})
            </span>
          ) : (
            <div>
              <div className="error">{tool.error}</div>
              {tool.python && tool.installHint && (
                <div className="small">
                  Install it from a terminal, then press Check again:{' '}
                  <code className="copyable">{tool.installHint}</code>
                </div>
              )}
            </div>
          )}
          <button
            className="small-btn"
            onClick={() => void checkTool()}
            disabled={checking || busy}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="diff-head">
          <h2>Install into</h2>
          <button
            className="small-btn"
            disabled={busy || writable.length === 0}
            onClick={() =>
              setTargets(
                allPicked ? new Set() : new Set(writable.map((a) => a.id)),
              )
            }
          >
            {allPicked ? 'Clear' : 'Pick all'}
          </button>
        </div>
        <ul className="guide-accounts">
          {accounts.map((a) => {
            const blocked = a.cloud === 'on';
            return (
              <li key={a.id}>
                <label
                  className={blocked ? 'muted' : ''}
                  title={blocked ? 'Steam Cloud is on for this account' : ''}
                >
                  <input
                    type="checkbox"
                    checked={targets.has(a.id)}
                    disabled={blocked || busy}
                    onChange={() => toggle(a.id)}
                  />
                  <span className="account-name">{a.name}</span>{' '}
                  <span className="muted small">{a.id}</span>
                </label>
                <CloudBadge account={a} />
              </li>
            );
          })}
        </ul>
        <label className="option">
          <input
            type="checkbox"
            checked={replace}
            disabled={busy}
            onChange={() => setReplace((r) => !r)}
          />{' '}
          Remove older D2PT guides for the same heroes
          <span className="muted small">
            {' '}
            · guides you made or got elsewhere are never touched
          </span>
        </label>
      </section>

      {busy && (
        <section className="card">
          <div className="diff-head">
            <h2>
              {progress?.phase === 'installing'
                ? 'Installing…'
                : 'Generating guides…'}
            </h2>
            {progress?.phase !== 'installing' && (
              <button
                className="small-btn"
                onClick={() => void api.cancelGuideImport()}
              >
                Cancel
              </button>
            )}
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className="progress-fill"
              style={{
                width: `${progress?.phase === 'installing' ? 100 : pct}%`,
              }}
            />
          </div>
          <p className="muted small">
            {!progress
              ? 'Starting d2pt-guides…'
              : progress.phase === 'installing'
                ? `Writing ${progress.generated} guides to ${targets.size} account${targets.size === 1 ? '' : 's'}`
                : `${progress.done}/${progress.total} heroes · ${progress.label} · ${progress.generated} guides so far`}
          </p>
        </section>
      )}

      <div className="pushbar">
        <div className="pushbar-text">
          {result ? (
            <ImportResultView result={result} names={byId} />
          ) : error ? (
            <span className="error">{error}</span>
          ) : busy ? (
            <span className="muted">Importing…</span>
          ) : blocker ? (
            <span className="muted">{blocker}</span>
          ) : (
            <span>
              Import D2PT guides into{' '}
              <strong>
                {[...targets].map((t) => byId.get(t)?.name).join(', ')}
              </strong>
            </span>
          )}
        </div>
        {(result || error) && !busy && (
          <button
            className="small-btn"
            onClick={() => {
              setResult(null);
              setError(null);
            }}
          >
            Dismiss
          </button>
        )}
        <button
          className="primary"
          disabled={!!blocker || busy}
          onClick={() => setConfirming(true)}
        >
          {busy ? 'Importing…' : 'Import guides'}
        </button>
      </div>

      {confirming && (
        <Confirm
          title="Import D2PT guides?"
          confirmLabel="Import"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void doImport()}
        >
          <p>Generate guides for every hero, then install them into:</p>
          <ul>
            {[...targets].map((t) => (
              <li key={t}>
                <strong>{byId.get(t)?.name}</strong>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {replace
              ? 'Older D2PT guides for the same heroes are removed. '
              : 'Older D2PT guides are kept; guides with the same file name are updated. '}
            Each account's current guides are zipped to a backup first. You can
            restore it from the Backups tab.
          </p>
        </Confirm>
      )}
    </div>
  );
}

function ImportResultView({
  result,
  names,
}: {
  result: GuideImportResult;
  names: Map<string, { name: string }>;
}) {
  if (result.error) return <span className="error">{result.error}</span>;
  return (
    <span>
      <span className="muted">
        {result.generated} guides for {result.heroes} heroes.{' '}
      </span>
      {result.results.map((r) => (
        <span key={r.accountId} className={r.ok ? 'ok' : 'error'}>
          {names.get(r.accountId)?.name ?? r.accountId}:{' '}
          {r.ok
            ? `${r.filesWritten} installed${r.filesRemoved ? `, ${r.filesRemoved} old removed` : ''}`
            : `${r.error}${r.rolledBack ? ' (rolled back)' : ''}`}
          {'  '}
        </span>
      ))}
      {result.ok && <span className="muted">Start Dota 2 to load them.</span>}
    </span>
  );
}
