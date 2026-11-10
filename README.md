# Dota 2 Config Sync

Windows desktop app (Electron + TypeScript + React) that copies Dota 2 hotkeys and settings
between the Steam accounts on one PC, with a key-by-key diff and a backup before every write.

## Commands

```bash
npm start          # run in development
npm test           # unit tests (fake Steam folder, never touches the real one)
npm run typecheck
npm run make       # Squirrel installer -> out/make/squirrel.windows/x64/Dota2ConfigSync-Setup.exe
```

Development runs only: set `D2CS_STEAM_PATH` to a copy of a Steam folder and `D2CS_DATA_DIR`
to a scratch folder to try pushes safely. The packaged app ignores both.

## Layout

- `src/main.ts`: window, security settings, IPC handlers (`listAccounts`, `getDiff`, `push`, `restore`)
- `src/preload.ts`: the four-function bridge to the UI
- `src/main/core.ts`: accounts, change detection, push, restore (no Electron imports, so it's testable)
- `src/main/categories.ts`: which files each category copies; account-bound convars kept on the target
- `src/main/kv.ts`, `diff.ts`: text and binary KeyValues parsers, flatten and key-by-key diff
- `src/main/steam.ts`: Steam path, account discovery, persona names, Steam Cloud status, Dota process check
- `src/main/backups.ts`: zip backups in `%APPDATA%\Dota 2 Config Sync\backups\<timestamp>\<account>\`
- `src/renderer/`: React UI

## Behavior notes

- Pushes are blocked while `dota2.exe` runs and for accounts with Steam Cloud on.
- Files are copied byte for byte, except convars files: account-bound convars (`name`, counters,
  "seen"/"acknowledged" markers, timestamps) keep the target's own values.
  See `ACCOUNT_BOUND_CONVARS` in `src/main/categories.ts`.
- Both `remote/` and `local/cfg/` copies are written. If the source has only one, it fills both.
- Files only on the target (e.g. extra guides) are left alone.
- "Changed since last check" compares with the snapshot saved the last time the app read the accounts.
