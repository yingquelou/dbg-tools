# Change Log

All notable changes to the "DBG Tools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Implement per-workspace caching: by default each workspace stores cache in `<workspace>/.vscode/dbg/modulesCache.json`.
- Add configuration `dbg.cachePath` to override the cache file or directory (supports relative paths resolved against workspace root).
- Change module function signature: modules now receive `(host, shared)` where `host` exposes controlled helpers (output channel, getConfig, cachePath, etc.).
- `dbg.get` command now only accepts a single string argument (e.g. `dbg.get("myKey")`); other call shapes return the string "undefined" and log a warning.
- Default modules directory remains `<workspace>/.vscode/user-modules`; `dbg.modulesPath` still available to override.
- Added example module demonstrating new signature and usage.
- Implemented automatic refresh controller (file-watcher + debounce + optional interval) to update cache automatically when modules change (configurable via `dbg.autoRefresh*` settings).