# Project instructions

This directory is the authoritative project root for the Zotero Cloud On Demand prototype.

- Plugin source files live at the project root; tests live in tests/; build scripts live in scripts/.
- Run npm test and python scripts/build.py after source or packaging changes. Build paths must resolve relative to the script, not the caller's current directory.
- Write user-facing build artifacts to outputs/ and intermediate research or temporary profiles to work/.
- The original pre-migration workspace is preserved under work/migration-original/ for provenance. Do not use that snapshot as editable source.
- Current supported range is Zotero 10 only. Do not widen compatibility to bypass errors.
- The plugin is experimental: real Zotero loading and real Baidu/Quark sync are not yet validated. Do not describe mock tests as real-account verification.
- Do not access real cookies/tokens or start a real library sync unless authorized for that operation. Use temporary profiles and mock providers for tests.
- Keep secrets out of source, logs, archives, and Git. Preserve local-only transient service binding and encrypted credential storage.
