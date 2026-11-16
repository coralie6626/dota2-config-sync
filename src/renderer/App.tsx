import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '../shared/types';
import { api, errorText, formatDate } from './api';
import { SyncView } from './SyncView';
import { BackupsView } from './BackupsView';

type Tab = 'sync' | 'backups';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>('sync');
  const [version, setVersion] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.listAccounts());
      setError(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>Dota 2 Config Sync</h1>
            {state && <div className="muted small">{state.steamPath}</div>}
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === 'sync' ? 'tab active' : 'tab'} onClick={() => setTab('sync')}>
            Sync
          </button>
          <button className={tab === 'backups' ? 'tab active' : 'tab'} onClick={() => setTab('backups')}>
            Backups{state && state.backups.length > 0 ? ` (${state.backups.length})` : ''}
          </button>
        </nav>
        <div className="topbar-right">
          {state && <span className="muted small">Last check: {state.lastCheck ? formatDate(state.lastCheck) : 'never'}</span>}
          <button onClick={() => void reload()} disabled={loading}>
            {loading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {state?.dotaRunning && (
        <div className="banner danger">
          <strong>Dota 2 is running.</strong> Pushing and restoring are disabled: Dota overwrites these files with what it
          holds in memory when it exits. Close Dota, then press Refresh.
        </div>
      )}
      {error && <div className="banner danger">{error}</div>}

      <main>
        {!state && !error && (
          <div className="boot">
            <div className="spinner" />
            <div>Reading Steam accounts…</div>
          </div>
        )}
        {state && state.accounts.length === 0 && (
          <div className="empty">
            No Steam accounts with a Dota 2 folder were found in <code>{state.steamPath}\userdata</code>.
          </div>
        )}
        {state && state.accounts.length > 0 && tab === 'sync' && (
          <SyncView state={state} version={version} onChanged={reload} />
        )}
        {state && tab === 'backups' && <BackupsView state={state} onChanged={reload} />}
      </main>
    </div>
  );
}
