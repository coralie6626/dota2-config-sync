import { useState } from 'react';
import type { AppState, BackupInfo, WriteResult } from '../shared/types';
import { api, categoryLabel, errorText, formatDate } from './api';
import { Confirm } from './Confirm';

interface Props {
  state: AppState;
  onChanged: () => Promise<void>;
}

export function BackupsView({ state, onChanged }: Props) {
  const [pending, setPending] = useState<BackupInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const names = new Map(state.accounts.map((a) => [a.id, a]));

  const doRestore = async (b: BackupInfo) => {
    setPending(null);
    setBusy(true);
    setMessage(null);
    try {
      const r: WriteResult = await api.restore(b.id, b.accountId);
      const first = r.results[0];
      setMessage(
        r.ok
          ? { ok: true, text: `Restored ${b.accountName} to ${formatDate(b.createdAt)}. The state before the restore was backed up too.` }
          : { ok: false, text: r.error ?? first?.error ?? 'Restore failed' },
      );
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  if (state.backups.length === 0) {
    return (
      <section className="card">
        <h2>Backups</h2>
        <p className="muted">No backups yet. Every push zips the target's files here first.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Backups</h2>
      {message && <div className={`banner ${message.ok ? 'success' : 'danger'}`}>{message.text}</div>}
      <table className="backups">
        <thead>
          <tr>
            <th>When</th>
            <th>Account</th>
            <th>Made before</th>
            <th>Categories</th>
            <th>Files</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.backups.map((b) => {
            const acc = names.get(b.accountId);
            const blocked = state.dotaRunning ? 'Close Dota 2 first' : !acc ? 'Account not found on this PC' : acc.cloud === 'on' ? 'Steam Cloud is on for this account' : null;
            return (
              <tr key={`${b.id}/${b.accountId}`}>
                <td>{formatDate(b.createdAt)}</td>
                <td>
                  {acc?.name ?? b.accountName} <span className="muted small">{b.accountId}</span>
                </td>
                <td>
                  {b.reason === 'push'
                    ? `push from ${names.get(b.sourceAccountId ?? '')?.name ?? b.sourceAccountId ?? '?'}`
                    : b.reason === 'import'
                      ? 'D2PT guide import'
                      : 'restore'}
                </td>
                <td>{b.categories.map(categoryLabel).join(', ')}</td>
                <td title={[...b.existed, ...b.created.map((f) => `${f} (created)`)].join('\n')}>
                  {b.existed.length}
                  {b.created.length > 0 && <span className="muted"> +{b.created.length} new</span>}
                </td>
                <td>
                  <button disabled={!!blocked || busy} title={blocked ?? ''} onClick={() => setPending(b)}>
                    Restore
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Hover the file count to see the files. Restore also deletes files that the write created.</p>

      {pending && (
        <Confirm title="Restore this backup?" confirmLabel="Restore" danger onCancel={() => setPending(null)} onConfirm={() => void doRestore(pending)}>
          <p>
            <strong>{pending.accountName}</strong>: put back {pending.existed.length} file{pending.existed.length === 1 ? '' : 's'} as they were on{' '}
            {formatDate(pending.createdAt)}
            {pending.created.length > 0 && <> and delete {pending.created.length} file{pending.created.length === 1 ? '' : 's'} the push created</>}.
          </p>
          <p className="muted small">The current files are backed up first, so this can be undone too.</p>
        </Confirm>
      )}
    </section>
  );
}
