// Types shared by the main process, the preload script and the React UI.

export const CATEGORY_IDS = [
  'hotkeys',
  'convars',
  'controlGroups',
  'heroGrid',
  'builds',
  'video',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryInfo {
  id: CategoryId;
  label: string;
  defaultOn: boolean;
  /** Paths relative to userdata\<id>\570, for display. `*` matches inside a file name. */
  patterns: string[];
}

export const CATEGORIES: readonly CategoryInfo[] = [
  {
    id: 'hotkeys',
    label: 'Hotkeys',
    defaultOn: true,
    patterns: ['remote/user_keys.vcfg', 'local/cfg/user_keys_0_slot*.vcfg'],
  },
  {
    id: 'convars',
    label: 'Settings',
    defaultOn: true,
    patterns: ['remote/user_convars.vcfg', 'local/cfg/user_convars_0_slot0.vcfg'],
  },
  {
    id: 'controlGroups',
    label: 'Control groups',
    defaultOn: true,
    patterns: ['remote/scripts/control_groups.txt'],
  },
  {
    id: 'heroGrid',
    label: 'Hero grid',
    defaultOn: true,
    patterns: ['remote/cfg/hero_grid_config.json'],
  },
  {
    id: 'builds',
    label: 'Builds and guides',
    defaultOn: false,
    patterns: ['remote/cfg/herobuilds.cfg', 'remote/guides/*.build'],
  },
  {
    id: 'video',
    label: 'Video and machine',
    defaultOn: false,
    patterns: ['local/cfg/video.txt', 'local/cfg/machine_convars.vcfg'],
  },
];

/**
 * off-global: Steam Cloud off for every game. off-dota: off for Dota 2 only.
 * on: no "disabled" setting found, so pushes to this account are blocked.
 */
export type CloudState = 'off-global' | 'off-dota' | 'on';

export interface KeyChange {
  /** Key path inside the file, e.g. ["bindings", "SPACE"]. */
  path: string[];
  kind: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
}

export interface FileDiff {
  /** Path relative to the 570 folder, with forward slashes. */
  file: string;
  /**
   * same: identical. changed: content differs. added: only in "after".
   * removed: only in "before". targetOnly (push diffs): only in the target, left as is.
   */
  status: 'same' | 'changed' | 'added' | 'removed' | 'targetOnly';
  changes: KeyChange[];
  /** The file couldn't be parsed, so only "the content differs" is known. */
  unparsed?: boolean;
  /** The bytes differ but every key and value is the same. */
  formattingOnly?: boolean;
}

export interface CategoryDiff {
  category: CategoryId;
  files: FileDiff[];
  /** True if a push would change something, or (for check results) something changed. */
  changed: boolean;
}

export interface Account {
  id: string;
  name: string;
  cloud: CloudState;
  /** Dota's last_sync_state from localconfig.vdf, only read when the cloud is on. */
  cloudSyncState: string | null;
  /** Category changes since the last check. Empty when nothing changed. */
  changes: CategoryDiff[];
  /** The account wasn't in the last snapshot (or there's no snapshot yet). */
  firstSeen: boolean;
}

export interface BackupInfo {
  /** Timestamp folder name, shared by every account written in one push. */
  id: string;
  accountId: string;
  accountName: string;
  createdAt: string;
  reason: 'push' | 'restore';
  sourceAccountId: string | null;
  categories: CategoryId[];
  /** Files that existed before the write (and are in the zip). */
  existed: string[];
  /** Files the write created (restore deletes them). */
  created: string[];
}

export interface AppState {
  steamPath: string;
  accounts: Account[];
  dotaRunning: boolean;
  /** When the snapshot used for "changed since last check" was taken. */
  lastCheck: string | null;
  backups: BackupInfo[];
}

export interface AccountResult {
  accountId: string;
  ok: boolean;
  error?: string;
  backupId?: string;
  filesWritten: number;
  rolledBack?: boolean;
}

export interface WriteResult {
  ok: boolean;
  /** Set when nothing was written at all (e.g. Dota is running). */
  error?: string;
  results: AccountResult[];
}

export interface Api {
  listAccounts(): Promise<AppState>;
  getDiff(sourceId: string, targetId: string, categories: CategoryId[]): Promise<CategoryDiff[]>;
  push(sourceId: string, targetIds: string[], categories: CategoryId[]): Promise<WriteResult>;
  restore(backupId: string, accountId: string): Promise<WriteResult>;
}

/** Separator for joining key paths into map keys. Never appears in config text. */
export const PATH_SEP = '\u001f';
