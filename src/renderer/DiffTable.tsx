import { useState } from 'react';
import type { FileDiff } from '../shared/types';

const ROW_LIMIT = 200;

interface Props {
  files: FileDiff[];
  beforeLabel: string;
  afterLabel: string;
  /** Wording for file-level statuses, which differ between "push" and "since last check". */
  mode: 'push' | 'check';
}

function fileNote(f: FileDiff, mode: Props['mode']): string | null {
  if (f.status === 'targetOnly') return 'Only on the target. Left as is.';
  if (f.status === 'added') return mode === 'push' ? 'New file on the target.' : 'New file.';
  if (f.status === 'removed') return 'File was deleted.';
  if (f.unparsed) return mode === 'push' ? 'Not readable key by key. The whole file is replaced.' : 'Not readable key by key. The content changed.';
  if (f.formattingOnly) return 'Same keys and values. Only spacing or order differs.';
  return null;
}

function Value({ v }: { v: string | null }) {
  if (v === null) return <span className="muted">—</span>;
  if (v === '') return <span className="muted">(empty)</span>;
  return <span title={v}>{v}</span>;
}

function FileBlock({ f, beforeLabel, afterLabel, mode }: { f: FileDiff } & Omit<Props, 'files'>) {
  const [all, setAll] = useState(false);
  const rows = all ? f.changes : f.changes.slice(0, ROW_LIMIT);
  const note = fileNote(f, mode);
  const showTable = !f.unparsed && f.changes.length > 0;
  return (
    <div className="file-block">
      <div className="file-head">
        <code>{f.file}</code>
        <span className={`pill ${f.status}`}>
          {f.status === 'targetOnly' ? 'kept' : f.status}
          {f.changes.length > 0 && !f.unparsed ? ` · ${f.changes.length} key${f.changes.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      {note && <div className="muted small file-note">{note}</div>}
      {showTable && (
        <table className="diff">
          <thead>
            <tr>
              <th>Key</th>
              <th>{beforeLabel}</th>
              <th>{afterLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.path.join('\u001f')} className={c.kind}>
                <td className="key" title={c.path.join(' › ')}>
                  {c.path.map((p, i) => (
                    <span key={i} className={i === c.path.length - 1 ? 'leaf' : 'branch'}>
                      {p}
                    </span>
                  ))}
                </td>
                <td className="before">
                  <Value v={c.before} />
                </td>
                <td className="after">
                  <Value v={c.after} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f.changes.length > ROW_LIMIT && !all && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {f.changes.length} keys
        </button>
      )}
    </div>
  );
}

export function DiffTable({ files, ...rest }: Props) {
  const shown = files.filter((f) => f.status !== 'same');
  if (shown.length === 0) return <div className="muted small">No differences.</div>;
  return (
    <div className="diff-files">
      {shown.map((f) => (
        <FileBlock key={f.file} f={f} {...rest} />
      ))}
    </div>
  );
}
