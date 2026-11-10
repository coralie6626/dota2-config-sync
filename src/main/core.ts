// The app's logic, independent of Electron so it can be tested on a fake Steam folder.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CATEGORY_IDS,
  type Account,
  type AccountResult,
  type AppState,
  type CategoryDiff,
  type CategoryId,
  type FileDiff,
  type WriteResult,
} from '../shared/types';
import { diffFile, fileState, type FileState } from './diff';
import { assertRealInside, atomicWrite, isNeverCopied, safeJoin } from './files';
import { isCategoryId, listCategoryFiles, planCopy, readCategoryState } from './categories';
import { Backups, BACKUP_ID_RE } from './backups';
import { discoverAccountIds, findSteamPath, isDotaRunning, readAccountMeta, type AccountMeta } from './steam';

type AccountSnapshot = Partial<Record<CategoryId, Record<string, FileState>>>;
interface Snapshot {
  version: 1;
  takenAt: string;
  accounts: Record<string, AccountSnapshot>;
}

export interface CoreOptions {
  dataDir: string;
  steamPath?: string;
  isDotaRunning?: () => Promise<boolean>;
}

const DOTA_RUNNING = 'Dota 2 is running. Close it before syncing: it overwrites these files when it exits.';

export class Core {
  private readonly backups: Backups;
  private readonly snapshotFile: string;
  private steamPath: string | null;
  private accounts = new Map<string, AccountMeta>();
  /** The snapshot from the previous check, loaded once per app run. undefined = not loaded yet. */
  private baseline: Snapshot | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: CoreOptions) {
    this.backups = new Backups(path.join(opts.dataDir, 'backups'));
    this.snapshotFile = path.join(opts.dataDir, 'snapshot.json');
    this.steamPath = opts.steamPath ?? null;
  }

  private dotaRunning(): Promise<boolean> {
    return (this.opts.isDotaRunning ?? isDotaRunning)();
  }

  /** Run writes one at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async getSteamPath(): Promise<string> {
    if (!this.steamPath) this.steamPath = await findSteamPath();
    return this.steamPath;
  }

  private rootOf(steamPath: string, id: string): string {
    return path.join(steamPath, 'userdata', id, '570');
  }

  private async refreshAccounts(): Promise<string> {
    const steamPath = await this.getSteamPath();
    const ids = await discoverAccountIds(steamPath);
    const next = new Map<string, AccountMeta>();
    for (const id of ids) next.set(id, await readAccountMeta(steamPath, id));
    this.accounts = next;
    return steamPath;
  }

  private requireAccount(id: unknown): string {
    if (typeof id !== 'string' || !this.accounts.has(id)) throw new Error(`Unknown account: ${String(id)}`);
    return id;
  }

  private requireCategories(cats: unknown): CategoryId[] {
    if (!Array.isArray(cats) || cats.length === 0 || !cats.every(isCategoryId)) {
      throw new Error('Pick at least one valid category');
    }
    return CATEGORY_IDS.filter((c) => cats.includes(c));
  }

  private async loadBaseline(): Promise<Snapshot | null> {
    if (this.baseline === undefined) {
      try {
        const s = JSON.parse(await fs.readFile(this.snapshotFile, 'utf8'));
        this.baseline = s && s.version === 1 && s.accounts ? (s as Snapshot) : null;
      } catch {
        this.baseline = null;
      }
    }
    return this.baseline;
  }

  private async saveSnapshot(s: Snapshot) {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    await atomicWrite(this.snapshotFile, Buffer.from(JSON.stringify(s)));
  }

  /** Discover accounts and compare each with the snapshot from the last check. */
  async listAccounts(): Promise<AppState> {
    return this.exclusive(async () => {
      const steamPath = await this.refreshAccounts();
      const baseline = await this.loadBaseline();
      const current: Snapshot = { version: 1, takenAt: new Date().toISOString(), accounts: {} };
      const accounts: Account[] = [];

      for (const [id, meta] of this.accounts) {
        const root = this.rootOf(steamPath, id);
        const snap: AccountSnapshot = {};
        const before = baseline?.accounts[id];
        const changes: CategoryDiff[] = [];
        for (const cat of CATEGORY_IDS) {
          const now = await readCategoryState(root, cat);
          snap[cat] = now;
          if (!before) continue;
          const old = before[cat] ?? {};
          const files: FileDiff[] = [];
          for (const f of [...new Set([...Object.keys(old), ...Object.keys(now)])].sort()) {
            const d = diffFile(f, old[f] ?? null, now[f] ?? null);
            if (d && d.status !== 'same') files.push(d);
          }
          if (files.length) changes.push({ category: cat, files, changed: true });
        }
        current.accounts[id] = snap;
        accounts.push({ id, ...meta, changes, firstSeen: !before });
      }

      await this.saveSnapshot(current);
      // On the very first run, later refreshes compare against this first snapshot.
      if (!baseline) this.baseline = current;
      return {
        steamPath,
        accounts,
        dotaRunning: await this.dotaRunning(),
        lastCheck: baseline?.takenAt ?? null,
        backups: await this.backups.list(),
      };
    });
  }

  /** What a push from source to target would change, key by key. */
  async getDiff(sourceId: string, targetId: string, categories: CategoryId[]): Promise<CategoryDiff[]> {
    const src = this.requireAccount(sourceId);
    const dst = this.requireAccount(targetId);
    const cats = this.requireCategories(categories);
    const steamPath = await this.getSteamPath();
    const srcRoot = this.rootOf(steamPath, src);
    const dstRoot = this.rootOf(steamPath, dst);

    const out: CategoryDiff[] = [];
    for (const cat of cats) {
      const plan = await planCopy(srcRoot, cat, dstRoot);
      const targetNow = await readCategoryState(dstRoot, cat);
      const files: FileDiff[] = [];
      for (const [f, buf] of plan) {
        const d = diffFile(f, targetNow[f] ?? null, fileState(f, buf));
        if (d) files.push(d);
      }
      for (const f of Object.keys(targetNow)) {
        if (!plan.has(f)) files.push({ file: f, status: 'targetOnly', changes: [] });
      }
      files.sort((a, b) => a.file.localeCompare(b.file));
      out.push({ category: cat, files, changed: files.some((f) => f.status === 'changed' || f.status === 'added') });
    }
    return out;
  }

  /** Write files into one account, with a backup first and a rollback if a write fails. */
  private async writeAccount(
    steamPath: string,
    accountId: string,
    files: Map<string, Buffer>,
    deletes: string[],
    backupId: string,
    info: { reason: 'push' | 'restore'; sourceAccountId: string | null; categories: CategoryId[] },
  ): Promise<AccountResult> {
    const meta = this.accounts.get(accountId)!;
    const root = this.rootOf(steamPath, accountId);
    const touched = [...new Set([...files.keys(), ...deletes])].sort();
    for (const f of touched) {
      if (isNeverCopied(f)) throw new Error(`Refusing to write ${f}`);
      await assertRealInside(root, safeJoin(root, f));
    }

    const backup = await this.backups.create(
      backupId,
      { accountId, accountName: meta.name, ...info },
      root,
      touched,
    );

    let written = 0;
    try {
      for (const [f, buf] of files) {
        await atomicWrite(safeJoin(root, f), buf);
        written++;
      }
      for (const f of deletes) await fs.rm(safeJoin(root, f), { force: true });
      return { accountId, ok: true, backupId, filesWritten: written };
    } catch (e) {
      // Put back what was there before.
      let rolledBack = false;
      try {
        const old = await this.backups.readFiles(backupId, accountId, backup);
        for (const [f, buf] of old) await atomicWrite(safeJoin(root, f), buf);
        for (const f of backup.created) await fs.rm(safeJoin(root, f), { force: true });
        rolledBack = true;
      } catch {
        // the backup is still there for a manual restore
      }
      return { accountId, ok: false, error: (e as Error).message, backupId, filesWritten: written, rolledBack };
    }
  }

  async push(sourceId: string, targetIds: string[], categories: CategoryId[]): Promise<WriteResult> {
    return this.exclusive(async () => {
      const steamPath = await this.refreshAccounts(); // fresh Steam Cloud status
      const src = this.requireAccount(sourceId);
      const cats = this.requireCategories(categories);
      if (!Array.isArray(targetIds) || targetIds.length === 0) throw new Error('Pick at least one target account');
      const targets = [...new Set(targetIds.map((t) => this.requireAccount(t)))];
      if (targets.includes(src)) throw new Error('The source account cannot also be a target');

      if (await this.dotaRunning()) return { ok: false, error: DOTA_RUNNING, results: [] };

      const srcRoot = this.rootOf(steamPath, src);
      const planFor = async (targetRoot: string) => {
        const plan = new Map<string, Buffer>();
        for (const cat of cats) for (const [f, buf] of await planCopy(srcRoot, cat, targetRoot)) plan.set(f, buf);
        return plan;
      };
      if ((await planFor(srcRoot)).size === 0) {
        return { ok: false, error: 'The source account has none of these files.', results: [] };
      }

      const backupId = await this.backups.newId();
      const results: AccountResult[] = [];
      for (const t of targets) {
        if (this.accounts.get(t)!.cloud === 'on') {
          results.push({ accountId: t, ok: false, error: 'Steam Cloud is on for this account.', filesWritten: 0 });
          continue;
        }
        if (await this.dotaRunning()) {
          results.push({ accountId: t, ok: false, error: DOTA_RUNNING, filesWritten: 0 });
          continue;
        }
        try {
          results.push(
            await this.writeAccount(steamPath, t, await planFor(this.rootOf(steamPath, t)), [], backupId, {
              reason: 'push',
              sourceAccountId: src,
              categories: cats,
            }),
          );
        } catch (e) {
          results.push({ accountId: t, ok: false, error: (e as Error).message, filesWritten: 0 });
        }
      }
      await this.cleanEmptyBackup(backupId);
      return { ok: results.every((r) => r.ok), results };
    });
  }

  /** Put an account's files back the way they were before a backed-up write. */
  async restore(backupId: string, accountId: string): Promise<WriteResult> {
    return this.exclusive(async () => {
      const steamPath = await this.refreshAccounts();
      const acc = this.requireAccount(accountId);
      if (typeof backupId !== 'string' || !BACKUP_ID_RE.test(backupId)) throw new Error('Unknown backup');
      const meta = await this.backups.readMeta(backupId, acc);
      if (!meta) throw new Error('Unknown backup');

      if (await this.dotaRunning()) return { ok: false, error: DOTA_RUNNING, results: [] };
      if (this.accounts.get(acc)!.cloud === 'on') {
        return { ok: false, error: 'Steam Cloud is on for this account. Turn it off for Dota 2 first.', results: [] };
      }

      const files = await this.backups.readFiles(backupId, acc, meta);
      const newId = await this.backups.newId();
      let result: AccountResult;
      try {
        result = await this.writeAccount(steamPath, acc, files, meta.created, newId, {
          reason: 'restore',
          sourceAccountId: null,
          categories: meta.categories,
        });
      } catch (e) {
        result = { accountId: acc, ok: false, error: (e as Error).message, filesWritten: 0 };
      }
      await this.cleanEmptyBackup(newId);
      return { ok: result.ok, results: [result] };
    });
  }

  private async cleanEmptyBackup(id: string) {
    const dir = path.join(this.opts.dataDir, 'backups', id);
    try {
      if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
    } catch {
      // ignore
    }
  }

  /** For tests: the files a category has in an account. */
  async categoryFiles(accountId: string, cat: CategoryId): Promise<string[]> {
    return listCategoryFiles(this.rootOf(await this.getSteamPath(), this.requireAccount(accountId)), cat);
  }
}
