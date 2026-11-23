# dsh-odoo-backup

[中文文档](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [中文更新日志](./CHANGELOG.zh-CN.md)

A [DeepSeek Harness](https://github.com/) (DSH) plugin for **Odoo 19 / Odoo 20 remote backup and safe restore** (same major version only).

It backs up the database, filestore, addons, runtime dependencies and configuration over SSH, and restores through a temp-database verification, downtime switch and rollback-on-failure state machine. Host-key trust is **fail-closed** — an unpinned or changed host key is refused.

- Bundle package name: `@local/dsh-odoo-backup`
- Current version: `0.2.8`
- Install source: `github:SamHo7524/dsh-odoo-backup#v0.2.8`
- License: private / internal use (`private: true` in `package.json`)

> **Supported: Odoo 19 and Odoo 20** — both verified on real machines. Backup and restore must happen **within the same major version** (19 → 19, 20 → 20). **Cross-major-version restore (e.g. 19 ↔ 20) is NOT supported**: the precheck version gate refuses it with both versions named. Moving across major versions is a separate upgrade project (migrate first, then start a new backup baseline).

---

## Install from GitHub

In DSH, install the bundle directly from this repository:

```
github:SamHo7524/dsh-odoo-backup#v0.2.8
```

Or install the release tarball from the [Releases page](https://github.com/SamHo7524/dsh-odoo-backup/releases/tag/v0.2.8):

```
dsh-odoo-backup-0.2.8.tgz
```

> Upgrading from `0.1.x`: the plugin was renamed from `dsh-odoo19-backup` to `dsh-odoo-backup` and this repository followed. Uninstall the old bundle (`@local/dsh-odoo19-backup`) first, then install the new one. The runtime entry id (`odoo-backup`) is unchanged, so your servers, passphrase and settings are preserved.
>
> Use `plugin_manager` (`install_bundle`) rather than copying files into `node_modules`: DSH re-runs `pnpm install` from the profile's `package.json` on every start, so only a durable install spec survives a restart.

After installing, **restart DSH** (Host-side `index.js` / `lib/*.js` changes require a full restart; the Client half needs only a hard refresh).

Verify the installation:

```
plugin_manager list_plugins    # include:odoo-backup -> @local/dsh-odoo-backup, fiberPhase: active
GET /odoo-backup/servers       # 200 {"ok":true,"servers":[...]}
odoo_backup { "action": "listServers" }   # { ok: true, servers: [...] }
```

---

## Features

| Area | What it does |
|:--|:--|
| Backup | Remote discovery (Docker / 1Panel / bare metal) → dump → package (DB + filestore + addons + `.local` deps + config) → encrypted download. Transfers ≥100 MiB are chunked (100 MiB parts), SHA-256 verified and **resumable** — a verified part is never re-downloaded. |
| Restore | R1 state machine: safety backup → temp restore → V1–V7 verification → downtime switch → verify → commit / automatic rollback. Bundles deploy addons and pydeps before the DB is switched, so a restored site starts with its real module set. |
| Version gate | Before any remote write, the backup's `MANIFEST.source.odooVersion` is compared with the target's discovered `odooVersion`. A provably cross-major pair (e.g. 19 ↔ 20) is **refused** (with both versions and two options: a same-major target, or treat the cross-major move as an upgrade project) and `/precheck` answers 409 without issuing a `confirmToken`; an unknown version proceeds with an explicit warning. |
| Diagnostics | Failures are never black-box: known modes (version/schema mismatch, DB already exists, disk full, SSH host-key vs auth, DB unreachable, timeout) render as raw error + 【诊断】 cause + 【建议】 next step; unknown errors pass through verbatim. The UI and both agent tools show the same text. |
| Restore options | Target database name (auto-discovered from the server's `dbfilter` or set explicitly) and **restore target domain** — rewrites `ir_config_parameter` / `website` domains from the source site to the target (e.g. `www.toogel.cn` → `odoo.toogel.cn`) before the switch completes. |
| Neutralize | After a restore (or on demand), `neutralize` puts the target site in a safe state for testing: it disables outgoing mail servers and cron jobs, keeps payment/test providers inert and rebrands the site. `odoo_backup`/UI expose status → precheck → apply, and the **Keep / Release neutralize** buttons let you complete the whole backup-restore loop without a shell. |
| Agent tools | `odoo_backup` (`test` / `discover` / `backup` / `listServers` / `fingerprint` / `pin`) and `odoo_restore` (`precheck` / `restore` / `status`). Read-only status, real SSH executions, single-use confirm token. |
| Settings UI | One dedicated page in DSH's native **Settings** (`settings.section`, id `odoo-backup`, with its own nav icon): Servers / Backup / Restore tabs, server CRUD, SSH fingerprint trust panel, connection test, passphrase credentials, local directory, real backup/restore progress bars, task cancel, server-level mutex, neutralize card. |
| Security | No SSH passwords; fail-closed host-key pinning; one-time 5-minute `confirmToken` bound to target + package; same-origin guard on UI routes; mandatory backup encryption (`DSHODOO1`, AES-256-GCM + scrypt). |

---

## Configuration

Open **DSH Settings → Odoo Backup & Restore** (the plugin registers its own settings section; it is no longer a card under Installed Plugins).

Each server supports:

| Field | Meaning |
|:--|:--|
| `name` / `host` / `port` / `user` | SSH connection identity |
| `keyPath` | Private key path; empty = SSH agent / ssh config alias |
| `sshConfigAlias` | A `Host` in `~/.ssh/config` — **fastest way to trust a host** (delegates key trust to your SSH config) |
| `pinnedFingerprint` | A manually verified `SHA256:...` host key |
| `extraPaths` | **Extra Paths**: absolute server paths packed into the same archive (knowledge base, `~/.hermes`, …); each has `name` / `path` / `exclude` / `maxBytes` |

**First-use checklist**

1. Add a server and fill `host` / `user` / `keyPath`.
2. Trust the host key — either set `sshConfigAlias`, or click **Scan fingerprint**, verify the fingerprint out-of-band, then paste it into `pinnedFingerprint`. Without one of these, `guardHostKey` refuses the connection (fail-closed, by design).
3. Click **Test connection** — should return real system info (OS / CPU / memory / Docker).
4. Set **`passphrase`** — backups are **rejected** without it (R10 mandatory encryption, fail-closed).

---

## Extra Paths (knowledge base / Hermes)

The Odoo chatbot answers from a knowledge base (e.g. `/root/Documents/Obsidian Vault`), and that knowledge base is **not** inside the database — backing up only the database means backing up the answers without the sources. This release folds such directories into the **same encrypted pipeline**: packed remotely → downloaded inside the same outer tar → encrypted by the same `encryptFile`.

In the **server edit form**, click **Add extra path**; each entry has:

| Field | Meaning |
|:--|:--|
| `name` | Prefix of the file inside the archive. Starts with a letter/digit, max 32 chars, must not collide with built-ins (`addons` / `pydeps` / `conf` / `dump` / `manifest` / `odoo`) |
| `path` | **Absolute** path on the server (must start with `/`; spaces and CJK are supported) |
| `exclude` | Comma-separated `--exclude` patterns. A pattern starting with `./` **anchors to the top level** (`./.git` excludes only the root `.git`, not nested ones) |
| `maxBytes` | Optional cap; exceeding it fails the whole backup, protecting against a mis-typed huge directory |

**Suggested starting point** (measured on toogel: vault ≈ 111 MiB, full `~/.hermes` ≈ 6.04 GiB):

```
vault   → /root/Documents/Obsidian Vault   exclude: ./.git, ./.obsidian
hermes  → /root/.hermes                    exclude: ./cache, ./*.lock
```

Excluding `cache` and lock files brings `~/.hermes` down to ≈ 4.77 GiB — without it you ship 1.4 GiB of regenerable cache for nothing.

**Three hard constraints (fail-closed, not configurable)**

1. **A missing path fails the entire backup**, and the error lists every offending entry and its path. It will *not* record "missing" and carry on the way the addons step does — otherwise you would believe the knowledge base is in the archive when it is not.
2. **Space budget before packing**: the remote host needs `extra × 1.5 + dump × 2 + 512 MiB` free; otherwise the run is refused with both readable numbers (required / available).
3. **Space precheck before downloading**: the local directory needs `archive size × 2.2`; otherwise refused, again with both numbers.

**Extra paths are not automatically restored in this release.** The restore pipeline only handles database / filestore / addons / conf; restoring extra paths is a **manual step** (by design — a knowledge base is a living document and blind overwrites risk data loss):

```bash
# 1) Obtain the outer tar from the encrypted archive
#    (the plugin's .tar.enc decrypts with the plugin passphrase into the outer tar)
# 2) Extract one extra-path archive
tar -xOf odoo-backup-<ts>.tar ./vault-<ts>.tar.zst > /tmp/vault.tar.zst
# 3) Verify compression integrity and contents
zstd -t /tmp/vault.tar.zst
tar -tf /tmp/vault.tar.zst | head
# 4) Extract to a scratch directory first — merge after review, never overwrite production directly
mkdir -p /tmp/vault-restore && tar -xf /tmp/vault.tar.zst -C /tmp/vault-restore
# 5) Compare sha256 against extras[].sha256 in MANIFEST.json before merging
```

**Compatibility**: archives that contain extra paths carry `formatVersion: "2.2"` plus an `extras` array in `MANIFEST.json`; archives without them stay at `2.1` and older archives remain readable and restorable (`package-meta` only reads `source`).

---

## Restore workflow

1. **Backup** tab → run a backup; when it completes the plugin backfills the verified final `.tar.enc` path into the restore input (the plaintext `.tar` inside the chunk working directory is **never** backfilled).
2. **Restore** tab → choose the package (`.tar.enc` only), target database and **target domain**; `precheck` issues a one-time token valid for 5 minutes.
3. Run restore → safety backup of the target → temp DB restore → V1–V7 verification → downtime switch → domain rewrite → `database.secret` rotation → verification → commit. Any failure rolls back to the pre-restore state automatically.
4. Optionally apply **neutralize** on the restored site and use **Keep / Release** to lock or lift it.

---

## Security model

- **Host keys**: `guardHostKey` allows only `sshConfigAlias` or a matching `pinnedFingerprint`; anything else is refused. `scanHostKey` only *reads* fingerprints — `pin` requires a manually confirmed value and re-verifies before writing `known_hosts`.
- **Confirm token**: `odoo_restore action=precheck` issues a token bound to `server + packagePath + neutralize`, valid 5 minutes and single-use (the path is normalized before binding, so a quoted `precheck` pairs with an unquoted `restore` — a different package is still rejected). `restore` without a valid token never reaches `service.restore`.
- **Same-origin guard**: `/odoo-backup/*` UI routes reject cross-origin requests (403). This is not an authentication boundary — DSH's own session/authorization is.
- **Encryption**: `DSHODOO1` format, AES-256-GCM + scrypt. Plaintext restore packages are refused by default.
- **Passphrase**: stored in the DSH Credentials service (`ODOO_BACKUP_PASSPHRASE`), never in plugin config, status responses or logs.
- **Mutex**: one backup/restore task per server; a stale lock stays fail-closed until explicitly confirmed.
- **Production safety**: the plugin never auto-deploys; real R1 switch / production rollout require explicit authorization and a maintenance window.

---

## Development

```bash
node --test "test/**/*.test.js"        # 925 tests
node --check index.js client.js lib/*.js
node scripts/release-sync-check.mjs    # verify tags ↔ GitHub Releases ↔ CHANGELOG ↔ README
```

Layout:

```
index.js            Host entry: Config schema, tools, UI JSON routes
client.js           Client UI (native settings.section page)
lib/                ssh, knownhosts, discover, backup, chunk-*, restore, verify, crypto,
                    dbguard, service, tools, tokens, neutralize, site-domain, config-value…
locale/             zh / en dictionaries
test/               node:test suites + manual verification scripts
scripts/            release-sync-check.mjs (release consistency gate)
```

---

## Release process (every update must sync everything)

A version is only "released" when **all** of these agree. A loop that skips any item is a broken release:

1. `package.json` `version` bumped.
2. `CHANGELOG.md` **and** `CHANGELOG.zh-CN.md` both have a `## [x.y.z]` section.
3. `README.md` and `README.zh-CN.md` both state the new version / install spec.
4. `node --test` green and `node --check` clean.
5. Tarball packed and uploaded as a **GitHub Release asset** — a git tag alone does not publish anything; the Releases page is a separate list.
6. Tag pushed and the release note carries the install line.

`scripts/release-sync-check.mjs` checks all of the above against the live repository (tags, Releases, release assets, both changelogs, both READMEs) and exits non-zero when something drifts. Run it before and after publishing.

The project is **not** a local git checkout during development; releases are published to GitHub by tag. See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## Status & limitations

- 925 / 925 unit tests pass; `node --check` clean across `index.js`, `client.js`, `lib/*.js` and the release scripts.
- Real-machine verified: `odoo_backup` `listServers` / `test` over SSH, `odoo_restore` status, the native settings section and its HTTP routes.
- **Not executed / not authorized**: real R1 downtime switch on the production primary database, agent-driven browser click-through, production deployment. Production servers were read-only throughout development.
- Host-side changes require a **full DSH restart**; the Client half only needs a hard refresh.

See [CHANGELOG.md](./CHANGELOG.md) for the full history (0.1.0 → 0.2.8), including the root-cause chains behind the path, DB-name, addons-deploy, volatile-config and tool-output defects.