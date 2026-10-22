# Installing on DeepSeek Harness 0.2.x

Measured on 2026-10-21 against **DSH 0.2.1-rc.2** (desktop 44.7.0, bundled
`@deepseek-ai/dsh@0.2.1-rc.2`) with **`@opencode2dsh/dsh-plugin@0.3.14`**.

The plugin needs no source change on 0.2.x. Two environment issues stop the
documented install command, and both are outside the plugin.

## 1. `dsh plugin --profile desktop` is refused

```
$ dsh plugin --profile desktop add @opencode2dsh/dsh-plugin
error: profile "desktop" is managed exclusively by the Electron application
```

`@deepseek-ai/dsh/lib/bin.js`:

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === "desktop")
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
}
```

This does not mean the plugin cannot run there; it means that profile's plugin
changes are meant to come from the desktop app. The equivalent change is to run
pnpm inside the profile directory **and** add the package to
`dsh.profile.bundles` — `dsh plugin` does that second step for you, a manual pnpm
run does not. A package that is installed but not selected is never loaded.

## 2. `ERR_PNPM_IGNORED_BUILDS` makes a finished install look failed

```
dependencies:
+ @opencode2dsh/dsh-plugin 0.3.14

[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @google/genai@1.52.0, protobufjs@7.6.6
```

The package is on disk, but pnpm exits 1 and `dsh` treats that as a failed
installation — it restores `package.json` and `pnpm-lock.yaml`. Both packages are
transitive dependencies of `pi-ai` whose build scripts are not needed at
runtime. Decide them in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@google/genai': false
  protobufjs: false
```

## One command

`scripts/install-dsh-profile.mjs` performs both steps for any profile, including
`desktop`, and verifies the result:

```sh
node scripts/install-dsh-profile.mjs --profile desktop
node scripts/verify-dsh-install.mjs --profile desktop
```

Both are dependency-free and Node ≥ 20. pnpm is taken from `PATH` when present,
otherwise from the copy the DeepSeek Harness installation or the dsh runtime
ships. Useful flags: `--version`, `--spec <pnpm spec>`, `--pnpm <path>`,
`--dry-run`.

Restart DeepSeek Harness afterwards: a newly added bundle is not hot-loaded.

The verifier reports three states. `pending` means the item can only be answered
after the host boots this profile — the health snapshot is written once per boot
at a global path, so a profile that has never booted can only be told apart from
one that has by comparing the snapshot's `writtenAt` against the profile's own
lockfile. `pending` is not a failure and the exit code stays 0:

```
[ok]   dependency declared  0.3.14
...
[--]   catalog ready        snapshot predates this install (...); boot this profile and re-run

6/6 checks passed, 1 pending
```

To install a build of this repository instead of the published release, pack it
and point the installer at the tarball — a tarball spec is never published
first:

```sh
cd packages/plugin && pnpm install && pnpm pack
cd ../.. && node scripts/install-dsh-profile.mjs --profile desktop \
  --spec ./packages/plugin/opencode2dsh-dsh-plugin-<version>.tgz
```

## Why 0.3.14 and not earlier

"Does not support the latest DSH" refers to **0.3.13 and earlier**:

| Issue | Symptom on 0.2.x | Fixed in |
| --- | --- | --- |
| #96 / #98 | `The 'reasoning_content' in the thinking mode must be passed back to the API` on the second step of a tool call | 0.3.14 |
| #99 | a session near 200k failed instead of compacting | 0.3.14, and again in `0.3.15-fork.1` (below) |
| #103 | truncated streams classified `UPSTREAM`, so the `TRANSPORT` retry policy never ran | 0.3.14 |

## The context ceiling, and why 0.3.14's 300k was still too high

`400 {"message":"Your request resulted in more tokens than this model's maximum
context length allows…","code":"context_length_exceeded"}` on
`deepseek-v4.1-flash-free` is not a network fault. The plugin advertises a
context window, and DSH compacts before the history reaches it — but the
advertised number has to account for how DSH actually computes that point:

```
messageBudget   = contextWindow - reservedCompletionTokens      # the model's maxTokens
pressureBudget  = messageBudget - headroomTokens                # headroomTokens default 65536
thresholdTokens = min(thresholdRatio × contextWindow, pressureBudget)   # thresholdRatio 0.8
```

With 0.3.14's 300000 and this model's 32000 output budget:

```
min(0.8 × 300000, 300000 − 32000 − 65536) = min(240000, 202464) = 202464
```

So compaction only fired at ~202k, while a wire prompt runs a few thousand
tokens above the host's estimate (system prompt plus the ~30 KB tool schema).
The first turn past that sent ~207k and was refused; worse, the compaction that
tried to recover carried the same history, was refused identically, and left the
session stuck — every later turn replayed the same failing request.

The lane's own ceiling also drifts: 0.3.14 was released against a 315,596-token
recall probe, but its notes already record a refusal at ~181.7k, and the
2026-10-22 failure above is consistent with the ceiling sitting near that lower
figure rather than at 300k.

`0.3.15-fork.1` declares **262144** for this model, which resolves to:

```
min(0.8 × 262144, 262144 − 32000 − 65536) = min(209715, 164608) = 164608
```

That leaves ~17k of margin below the lowest refusal measured on the lane while
keeping >160k of usable context. `mimo-v2.6-flash-free` stays at 1048576: its
window is verified on this lane, so it is not the same class of risk.

If you would rather not change the plugin, the same effect is reachable from the
DSH side in the profile's `cordis.patch.yml` (`thresholdRatio` applies to the
routed target only):

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    modelPolicies:
      - provider: opencode2dsh
        model: deepseek-v4.1-flash-free
        thresholdRatio: 0.55   # 0.55 × 300000 ≈ 165000, matching the fork build
```

`retainRatio` must stay below `thresholdRatio`, or the host refuses to start.

A session already stuck on this error cannot be rescued by a smaller window: its
history is larger than the ceiling, so both the normal request and the
compaction request fail. Switch that session to a model with a verified larger
window (`mimo-v2.6-flash-free`), run compaction there, then switch back.

## Measured on 0.2.1-rc.2

- model picker shows the `opencode2dsh` group with 9 free models;
- `big-pickle` completes a GUI turn (`1 轮 1 步 · 91 tok/s`) with no reasoning
  pass-back error;
- a headless run completes a tool round trip (`pwsh` tool → stdout read back by
  the model), so 0.2's `toolResult` message shape is handled;
- the settings page mounts: Plugins → `@opencode2dsh/dsh-plugin` → configure
  renders the whole IP-pool form (free sources, manual exits, subscriptions,
  sing-box, pinned exit, probe-model picker, save);
- health snapshot: `{"status":"ready","total":86,"exposed":9,"lastError":""}`.

## Limits that are not DSH-version related

- **403 `FreeTierError`** — Zen's free-tier credential gate. 0.3.13+ offers an
  opt-in local delegation (`delegation.enabled`, off by default) that custodies
  a local opencode credential.
- **429** — the anonymous lane is rate limited per IP. The plugin already
  retries with backoff; the IP pool in the settings page spreads exits.
- **Context window** — `deepseek-v4.1-flash-free` declares 300k, measured to
  drift with egress and time.
