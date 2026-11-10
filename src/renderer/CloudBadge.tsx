import { useState } from 'react';
import type { Account } from '../shared/types';

export function CloudBadge({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  if (account.cloud === 'off-global') return <span className="badge quiet">Steam Cloud off (all games)</span>;
  if (account.cloud === 'off-dota') return <span className="badge quiet">Steam Cloud off (Dota 2)</span>;
  return (
    <div className="cloud-on" onClick={(e) => e.stopPropagation()}>
      <button className="badge danger" onClick={() => setOpen(!open)}>
        Steam Cloud on {open ? '▴' : '▾'}
      </button>
      {account.cloudSyncState && <span className="muted small"> sync state: {account.cloudSyncState}</span>}
      {open && (
        <div className="cloud-help small">
          Pushes to this account are blocked: Steam may restore its cloud copy over the new files or ask about
          a conflict. To fix it:
          <ol>
            <li>In Steam: Library → Dota 2 → Properties → General, turn off Steam Cloud.</li>
            <li>Close Steam so it saves the setting.</li>
            <li>Reopen this app.</li>
          </ol>
          This account can still be the source of a copy.
        </div>
      )}
    </div>
  );
}
