# Foreground Fallback Diagnostic

## Background

`ForegroundFallbackManager` (`src/hooks/foreground-fallback/index.ts`) detects rate-limit
errors from OpenCode plugin events (`session.error`, `session.status`, `message.updated`)
and switches to the next model in the agent's configured fallback chain.

## Problem

The OpenCode proxy returns **"Monthly usage limit reached"** for all models going through
it. The fallback should cascade through the chain until it finds a working model, but on a
fresh session it stops after one switch.

## History

### Round 1: RC1 — Status type guard (Fixed)

**Hypothesis:** The `session.status` handler required `type === 'retry'` to process events.
When the proxy returned monthly limit on a fresh session with no prior retry, the type might
be `'error'` instead, silently dropping the event.

**Fix applied:** Removed `props.status?.type !== 'retry'` guard. The keyword matching on
`status.message` is specific enough.

**Result:** The fix deployed. Events ARE detected. `tryFallback` IS called. But the cascade
still stops after one switch.

### Round 2: RC2 — Dedup window blocking cascade (Current)

**Evidence from log `oh-my-opencode-slim.20260703T185433.log`:**

Two errors arrive within 876ms for the same session. The first triggers a fallback
(opencode/mimo-v2.5-free → opencode-go/mimo-v2.5). The second is silently deduped
because `Date.now() - lastTrigger = 876ms < 5000ms`.

```
18:54:40.637  session.status (busy — first prompt starts)
18:54:40.890  session.status with error: "Free usage exceeded, subscribe to Go"
18:54:40.891  tryFallback { dedupMs: 1783104880891 }  ← first call, lastTrigger was 0
18:54:40.918  session.idle
18:54:41.434  switched to fallback model: opencode/mimo-v2.5-free → opencode-go/mimo-v2.5
18:54:41.442  message.updated (new model starts responding)
18:54:41.446  session.status (busy)
18:54:41.505  session.status (busy)
18:54:41.767  session.status with error: "monthly usage limit reached..."
18:54:41.767  tryFallback { dedupMs: 876 }  ← SECOND call, 876ms < 5000ms → **DEDUPED**
18:54:55.375  session.updated (13 seconds later — no second switch happened)
```

**Root cause:** The `lastTrigger` timestamp is set when tryFallback first runs
(18:54:40.891). After the fallback switches models and the new model also fails
(18:54:41.767), the dedup guard sees `876ms < 5000ms` and returns early. The
second fallback is silently swallowed — the chain has remaining models but they're
never tried.

**Why the dedup exists:** Prevents duplicate events for the same rate-limit incident
(e.g. three `session.status` events all firing for the same proxy error). This is
correct behavior.

**Why it breaks the cascade:** After a successful model switch, the new model's
failure is a *separate incident*. The dedup timer should be reset so the next
cascade step can proceed. Currently the timer persists from the original incident.

## Fix applied (RC2)

**File:** `src/hooks/foreground-fallback/index.ts`

**Change:** Make dedup model-aware. Added `lastTriggerModel` map that records which model
was in use when the dedup timer was set. The dedup is bypassed when the model has changed
since the last trigger — the new model's failure is a separate incident.

```typescript
// Before fix: per-session dedup, blocks all triggers within 5s
if (now - this.lastTrigger.get(sessionID) < DEDUP_WINDOW_MS) return;

// After fix: dedup is model-aware, allows cascade on model change
const lastModel = this.lastTriggerModel.get(sessionID);
const curModel = this.sessionModel.get(sessionID);
const modelChanged = lastModel !== undefined && lastModel !== curModel;
if (!modelChanged && now - this.lastTrigger.get(sessionID) < DEDUP_WINDOW_MS) return;
this.lastTrigger.set(sessionID, now);
this.lastTriggerModel.set(sessionID, curModel);
```

This way:
1. Model A fails `[lastModel: undefined, curModel: A]` → `modelChanged = false` → dedup normal → switches to B
2. Model B fails `[lastModel: A, curModel: B]` → `modelChanged = true` → bypass dedup → switches to C
3. Cascade continues through chain

Duplicate events for the SAME model are still deduped (same `lastModel` and `curModel`).

## Log evidence summary

### Session `ses_0d6aac3d3ffe17U1EIUYi3kIm2` cascade (185433.log)

| Time | Event | Notes |
|------|-------|-------|
| 18:54:40.637 | session.status (busy) | First prompt |
| 18:54:40.890 | session.status (error: Free usage exceeded) | Model A fails |
| 18:54:40.891 | tryFallback (dedupMs: 1.7B) | First call — proceeds |
| 18:54:41.434 | switched: mimo-v2.5-free → opencode-go/mimo-v2.5 | Model B selected |
| 18:54:41.767 | session.status (error: monthly usage limit) | Model B also fails |
| 18:54:41.767 | tryFallback (dedupMs: 876) | **DEDUPED** — 876 < 5000 |
| — | *no second switch* | Cascade dead — chain had remaining models |

### Session cascade that worked (182121.log)

```
switched to fallback model: opencode/mimo-v2.5-free → opencode-go/mimo-v2.5
switched to fallback model: opencode-go/glm-5.2     → nvidia/minimaxai/minimax-m3
fallback chain exhausted: tried 4 models
```

This worked because errors arrived **minutes apart**, not milliseconds.

## What the RC1 fix actually fixed

Removing the `type !== 'retry'` guard was still correct. It allows `session.status`
events with type `'error'` (or any other non-standard type) to be processed. Without
this fix, even the first cascade step wouldn't work on a fresh session.

But it wasn't sufficient — the cascade still blocked on step 2.

## Reading the logs (updated)

Plugin log location: `~/.local/share/opencode/log/oh-my-opencode-slim.*.log`

| Log pattern | What it means |
|---|---|
| `event { type: "...", sessionID: "...", error: "..." }` | Event arrived at the handler |
| `tryFallback { dedupMs: <N> }` | Fallback was entered. N = ms since last trigger. |
| `tryFallback { dedupMs: < 5000 }` | **Dedup blocked** — second incident within the window |
| `switched to fallback model { from: "..." to: "..." }` | Model successfully switched |
| `event + tryFallback + dedupMs < 5000 + no switched` | **RC2 pattern** — cascade blocked by dedup |
| NO `event` log when monthly limit fires | **RC1 pattern** (fixed) — event never reaches handler |

## What we did this round

1. **Investigated log `oh-my-opencode-slim.20260703T185433.log`** — traced a real monthly
   limit cascade: the RC1 fix WAS detecting the event and calling tryFallback, but the
   second model switch was blocked by the 5-second dedup window (876ms < 5000ms).
2. **Identified RC2:** The dedup timer (`lastTrigger`) was per-session only. After model A
   failed and the fallback switched to model B, model B's failure within 5 seconds was
   incorrectly deduped because the timer still reflected model A's incident.
3. **Applied RC2 fix:** Made dedup model-aware. Added `lastTriggerModel` map. Dedup is
   bypassed when `lastModel !== curModel` — the new model's failure is a separate incident.
4. **Wrote failing test first,** then implemented fix. 37/37 pass.
5. **Built and verified:** `bun run build && bun run check:ci && bun test` (1302/1302 pass).

## Status

- **RC1 fix:** Deployed. Removed `type !== 'retry'` guard from `session.status` handler.
- **RC2 fix:** Deployed. Model-aware dedup (`lastTriggerModel`). Tested — 37/37 pass.
- **Build:** `bun run build && bun run check:ci && bun test` — clean.
- **Dist deployed:** `dist/index.js` rebuilt at `2026-07-03 19:57` local time.

## How to test

Reload the plugin in OpenCode (hot-reload or restart), then use a model that goes
through the OpenCode proxy. When the proxy returns monthly/5-hour/weekly usage limit:

### Expected log pattern (verification: confirm all 3 appear per model that fails)

```
[foreground-fallback] event {"type":"session.status","sessionID":"ses_xxx",
  "error":"monthly usage limit reached..."}
[foreground-fallback] tryFallback {"sessionID":"ses_xxx","inProgress":false,
  "dedupMs":<large or <5000>}
[foreground-fallback] switched to fallback model {"from":"opencode/model-a",
  "to":"opencode/model-b"}
```

If the cascade works across N models, you should see N copies of the above pattern,
each with a different `to` model, until the chain is exhausted or a model succeeds.

### What to check

| Pattern | Verdict |
|---------|---------|
| `event` + `tryFallback` + `switched` (repeated per model) | ✅ Cascade working |
| `event` + `tryFallback` with `dedupMs < 5000` + NO `switched` | ❌ RC2 still broken — check `lastTriggerModel` logic |
| NO `event` log at all when monthly limit fires | ❌ RC1 regression — check `session.status` handler |
| Everything fires but all models fail | ⚠️ All models behind same proxy — can't code-fix, need config change |

### Key log lines to grep

```bash
# See each cascade step
rg "foreground-fallback.*(switched to fallback model|tryFallback)" \
  ~/.local/share/opencode/log/oh-my-opencode-slim.*.log

# Check for blocked cascade (dedup < 5s with no follow-up switch)
rg "dedupMs.*[0-9]{1,3}\}" \
  ~/.local/share/opencode/log/oh-my-opencode-slim.*.log
