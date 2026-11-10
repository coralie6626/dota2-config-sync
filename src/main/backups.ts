// Zip backups in <data>/backups/<timestamp>/<account id>/ (files.zip + meta.json).

import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { BackupInfo, CategoryId } from '../shared/types';
import { readIfExists, safeJoin } from './files';
import { isCategoryId } from './categories';

export const BACKUP_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;
const ACCOUNT_RE = /^[1-9]\d{0,11}$/;

export class Backups {
  constructor(private readonly dir: string) {}

  /** A new, unused timestamp folder name. */
  async newId(): Promise<string> {
    const base = new Date().toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n++) {
      const id = n === 0 ? base : `${base}-${n}`;
      try {
        await fs.mkdir(path.join(this.dir, id), { recursive: false });
        return id;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          await fs.mkdir(this.dir, { recursive: true });
          n--;
          continue;
        }
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  /** Zip the files a write will touch. Files that don't exist yet are recorded as "created". */
  async create(
    id: string,
    info: Omit<BackupInfo, 'id' | 'createdAt' | 'existed' | 'created'>,
    root: string,
    files: string[],
  ): Promise<BackupInfo> {
    const zip = new AdmZip();
    const existed: string[] = [];
    const created: string[] = [];
    for (const f of files) {
      const buf = await readIfExists(safeJoin(root, f));
      if (buf) {
        zip.addFile(f, buf);
        existed.push(f);
      } else created.push(f);
    }
    const meta: BackupInfo = { ...info, id, createdAt: new Date().toISOString(), existed, created };
    const dir = path.join(this.dir, id, info.accountId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'files.zip'), zip.toBuffer());
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async list(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = [];
    let ids: string[];
    try {
      ids = await fs.readdir(this.dir);
    } catch {
      return out;
    }
    for (const id of ids.filter((x) => BACKUP_ID_RE.test(x))) {
      let accounts: string[];
      try {
        accounts = await fs.readdir(path.join(this.dir, id));
      } catch {
        continue;
      }
      for (const acc of accounts.filter((x) => ACCOUNT_RE.test(x))) {
        const meta = await this.readMeta(id, acc);
        if (meta) out.push(meta);
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async readMeta(id: string, accountId: string): Promise<BackupInfo | null> {
    if (!BACKUP_ID_RE.test(id) || !ACCOUNT_RE.test(accountId)) return null;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.dir, id, accountId, 'meta.json'), 'utf8'));
      const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
      return {
        id,
        accountId,
        accountName: typeof raw.accountName === 'string' ? raw.accountName : accountId,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
        reason: raw.reason === 'restore' ? 'restore' : 'push',
        sourceAccountId: typeof raw.sourceAccountId === 'string' ? raw.sourceAccountId : null,
        categories: strings(raw.categories).filter(isCategoryId) as CategoryId[],
        existed: strings(raw.existed),
        created: strings(raw.created),
      };
    } catch {
      return null;
    }
  }

  /** The backed-up bytes of every file that existed before the write. */
  async readFiles(id: string, accountId: string, meta: BackupInfo): Promise<Map<string, Buffer>> {
    const zip = new AdmZip(path.join(this.dir, id, accountId, 'files.zip'));
    const out = new Map<string, Buffer>();
    for (const f of meta.existed) {
      const entry = zip.getEntry(f);
      if (!entry) throw new Error(`Backup is missing ${f}`);
      out.set(f, entry.getData());
    }
    return out;
  }
}
