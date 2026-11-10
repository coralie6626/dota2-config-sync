import { useEffect, type ReactNode } from 'react';

interface Props {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

export function Confirm({ title, confirmLabel, danger, onConfirm, onCancel, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className={danger ? 'danger-btn' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
