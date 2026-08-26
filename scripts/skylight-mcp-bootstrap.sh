#!/usr/bin/env bash
#
# CANONICAL DEFINITION of the Skylight MCP bootstrap command for the Aurora
# agent group (`skylight-morning`). This file is the single source of truth.
#
# It is not executed from here. `scripts/skylight-mcp-bootstrap.ts` reads it,
# drops the `#` comment lines, collapses the remaining whitespace into one
# line, and `scripts/setup-aurora-agent.ts` stores that line as
#   container_configs.mcp_servers -> skylight.args[1]   (in data/v2.db)
# which is what the container actually runs, as `bash -lc "<line>"`.
# It has to be inlined there because the container has no access to this repo:
# /workspace/extra/skylight is the Skylight source, mounted READ-ONLY, and the
# venv is per-session under /workspace.
#
# `scripts/skylight-mcp-bootstrap.test.ts` checks the stored DB line against
# this file, but only when run with SKYLIGHT_LIVE_DB_CHECK=1 (see
# docs/runbooks/aurora-skylight-mcp.md) — the default `pnpm test` is hermetic
# and only checks that this file, the seeder, and the runbook agree with each
# other, not the live DB. Change this file, re-run the seeder, restart the
# group.
#
# Constraints this file must respect (the loader enforces the first three):
#   - No `#` outside the leading comment block, and no inline comments: after
#     the collapse a `#` would comment out the rest of the single line.
#   - No runs of two or more spaces — the collapse changes on any run of them.
#   - No line ending in a trailing `\` line-continuation: joining it to the
#     next line with a plain space turns the backslash into a spurious
#     escaped-space argv element that was never in the source.
#   - No line breaks inside a quoted string (the loader does NOT check this
#     one — a multi-line quoted string collapses newline-to-space silently,
#     changing the value without erroring). Keep quoted strings on one line.
#   - Every statement ends in `;` so the collapsed one-liner still parses.
#
# Background: docs/runbooks/aurora-skylight-mcp.md.
#
# Why provisioning fails LOUDLY. The original guard was `[ -d "$V" ] || install`,
# which only tested that the directory existed -- and `python3 -m venv` creates it
# before pip runs, so any pip failure left a half-built venv that satisfied the
# guard forever after. Every later launch skipped the reinstall and exec'd a python
# whose venv was missing most of its dependencies, surfacing as a downstream
# `ModuleNotFoundError: No module named 'anyio'` that reads like a code bug rather
# than a provisioning one. This bit Aurora three separate times (TASK-5).
#
# The guard is now a sentinel file written only after pip exits 0 AND the import
# probe succeeds, so an interrupted install is indistinguishable from no install
# and gets rebuilt from scratch. On failure we exit non-zero with the venv path on
# stderr instead of falling through to `exec ... -m server`.
#
# The probe is `import server.app`, run from the same cwd the server runs from.
# `import server` is useless as a health check: server/__init__.py imports nothing
# at module level (docstring + __all__ + a lazy __getattr__), so it succeeds on a
# venv holding the wheel and none of its ~70 dependencies. `server/app.py` is where
# `from fastmcp import FastMCP` lives, so importing it exercises the dependency
# closure. Running the probe from /workspace/extra/skylight rather than `/` also
# makes it check the code that actually executes: `exec ... -m server` puts the cwd
# ahead of site-packages on sys.path, so the running server is the read-only source
# mount and the venv supplies only the dependencies.
#
# The sentinel is deleted *before* the `rm -rf`, not after: two launches can both
# observe "no sentinel" and race, and if the second one's `rm -rf` is killed partway
# through a tree the first has already sentinelled, the survivor is a gutted venv
# that looks provisioned forever. Removing the token first means any interruption
# leaves an unsentinelled venv, which is always rebuilt.
#
# Two failure helpers, because the advice differs: `fail` is for provisioning (the
# venv is suspect -- say so, and offer `rm -rf $V`), `die` is for the steps after the
# sentinel is written (the venv is fine; the cause is almost always a missing mount,
# and deleting ~100 MB of healthy venv would not help).
#
# Everything chatty is redirected to stderr: this process's stdout is the MCP
# stdio JSON-RPC channel, so pip's (now un-`-q`'d) progress output would corrupt it.
#
# The version appears once, as VER= below; the venv path and the wheel filename are
# both derived from it. Bumping it gives a fresh venv rather than a dirty in-place
# upgrade -- see "Bumping the Skylight wheel" in the runbook.

set -u;
VER=0.2.3;
V=/workspace/.skylight-venv-$VER;
W=/workspace/extra/skylight/dist/skylight-$VER-py3-none-any.whl;
fail() { echo "skylight-mcp: PROVISIONING FAILED ($1). venv=$V wheel=$W. Refusing to start the server -- launching it now would surface as a misleading ModuleNotFoundError. The incomplete venv has no sentinel and will be rebuilt from scratch on the next launch; to force that now, rm -rf $V. See docs/runbooks/aurora-skylight-mcp.md." >&2; exit 1; };
die() { echo "skylight-mcp: STARTUP FAILED ($1). The venv at $V is provisioned and healthy -- this is not a provisioning problem, so do NOT delete it. The usual cause is a missing or misconfigured mount: /workspace/extra/skylight comes from container_configs.additional_mounts. See docs/runbooks/aurora-skylight-mcp.md." >&2; exit 1; };
if [ ! -f "$V/.provisioned" ]; then
  echo "skylight-mcp: provisioning $V from $W" >&2;
  rm -f "$V/.provisioned" || fail "could not invalidate stale sentinel";
  rm -rf "$V" || fail "could not remove stale venv";
  python3 -m venv "$V" >&2 || fail "python3 -m venv failed";
  "$V/bin/pip" install "$W" >&2 || fail "pip install failed";
  ( cd /workspace/extra/skylight && "$V/bin/python" -c "import server.app" ) >&2 || fail "post-install import check failed - venv is missing dependencies";
  : > "$V/.provisioned" || fail "could not write sentinel";
  echo "skylight-mcp: provisioned OK" >&2;
fi;
mkdir -p /workspace/.skylight || die "mkdir /workspace/.skylight failed";
cd /workspace/extra/skylight || die "cd /workspace/extra/skylight failed";
exec "$V/bin/python" -m server
