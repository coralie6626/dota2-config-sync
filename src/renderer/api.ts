import { CATEGORIES, type Api, type CategoryDiff, type CategoryId, type FileDiff } from '../shared/types';

declare global {
  interface Window {
    api: Api;
  }
}

export const api: Api = window.api;

export const categoryLabel = (id: CategoryId) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

export const keyCount = (d: CategoryDiff | FileDiff[]) =>
  (Array.isArray(d) ? d : d.files).reduce((n, f) => n + f.changes.length, 0);

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
