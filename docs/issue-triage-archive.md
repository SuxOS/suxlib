# Issue/PR triage archive

This is a chronological record of past build-batch triage decisions (which issues
were blocked, why, and how that got resolved) that used to live inline in
`CLAUDE.md`. It's history, not a live convention — nothing here is guaranteed to
still be true of the current repo state. Pruned out of `CLAUDE.md` per #460 so the
file every agent reads first stays durable knowledge rather than an ever-growing
journal. Durable conventions (governor, cancellation, checkpoint, otel runId/callId,
etc.) stay in `CLAUDE.md`'s House style section.

- **Before reimplementing a requeued issue, check for a stale closed-PR builder
  branch**: a prior attempt's branch (`git fetch origin
  bot/issue-build-<run-id>`, findable via the issue's own comment history/linked
  PRs) can still exist even after its PR was closed without merging — diff it
  against current `main` for the relevant path (`git diff main <branch> --
  <path>`) to turn a from-scratch design task into a verify-and-adapt one. Don't
  merge/cherry-pick it wholesale though — it may predate a feature that's since
  landed on `main` (see #143/#162), so reimplement against current `main` using
  it as a reference, not a patch. When several sibling stale branches exist for
  the same issue (multiple prior batches each attempted it independently),
  they can diverge in actual design/naming — and a since-filed follow-up issue
  for the "next increment" may describe function/line details from a sibling
  attempt that wasn't the one ultimately merged (#143's own follow-ups, #145
  and #161, cite a `validatePipeShapes` name/lines that don't match the
  `shapeCompatible`/`stepShape` implementation that actually landed from a
  different sibling branch) — verify a follow-up issue's cited names/lines
  against current code rather than trusting them verbatim.
  Update (#409): a stale branch's CI failure doesn't always mean its core
  logic is broken — `bot/issue-build-29820298284` (PR #419, closed unmerged)
  implemented #409 correctly but failed `Test & build` on a parse error
  ("Identifier `checkpointConfigModule` has already been declared") because
  a *different*, since-merged PR (#416) had independently added an
  identically-named test helper to the same file. Read the actual CI log
  before writing off a whole stale branch as unusable — a same-file test-
  scaffolding collision between two sibling batches is a different failure
  class than a real logic bug, and here it meant reusing #416's already-
  landed helper (dropping the branch's own duplicate copy) instead of
  redesigning anything.
- **A follow-up issue can be filed against a prerequisite that hasn't merged
  yet.** #242 (trace snapshot budget guard, follow-up to #234) and #250/#251
  (follow-ups to #247's sink governance) were all still queued as buildable
  while #234 and #247 themselves sat unmerged in their own open PRs (#241,
  #249) — so the feature/field the follow-up describes (`trace: 'full'`,
  `SinkOpts`, `sink.fanout(names, opts?)`) doesn't exist on `main` at all yet.
  Before building a follow-up issue, grep current `main` for the symbol it
  names; if absent, check whether the prerequisite issue is still open with
  an unmerged PR and drop the follow-up as blocked (not superseded) rather
  than reimplementing the prerequisite yourself and risking duplicate/
  conflicting work when that PR lands. Update (#267): don't stop at "still
  unmerged" — check *why* with `gh pr checks <prereq-pr>` /
  `gh run view <run-id> --log-failed`. #241 (#234) and #249 (#247) are each
  stuck on one concrete, fixable CI failure, not flakiness: #241 fails
  `security-review` with exactly the finding #242 itself describes
  (`snapshotValue()` has no byte/node-count budget); #249 fails `Test &
  build` because the sink-governance change broke per-target trace emission
  for sink fanout
  (`test/runtime/inline-trace.test.ts > runInline traces a sink fanout`). A
  batch that lands #234 or #247 should fix that PR's own failure as part of
  the same change (folding #242's budget guard into #241's work, fixing the
  trace regression as part of #249's work) — that closes the follow-up issue
  as a side effect instead of every future batch re-claiming and re-dropping
  #242/#251 as a no-op forever. Update: #247 landed this way, but via a
  *different* PR than the one this note originally named — #249 itself was
  closed unmerged; #281 ("feat: per-file --mtime for CLI archive create;
  gate sink writes through runGoverned") is the PR that actually fixed the
  trace regression and merged, closing #247 (and #246). #251 (per-target
  sink.fanout opts) built cleanly on top once #247 landed. #234/#241 (the
  `trace: 'full'` snapshotValue budget guard, #242's prerequisite) were
  still open/stuck as of this note — don't assume a prerequisite's PR number
  stays fixed once you go looking; re-check via `gh pr list --search
  "<issue>" --state all` rather than trusting a previously-recorded PR
  number.
- Update (2026-07-21, #414): the #320/#337 `security-review` missing-script
  infra gap (extensively documented above) is now RESOLVED — closed both
  issues after confirming the 10 most recent `security-review` workflow runs
  on this repo all pass or fail on a genuine CONFIRMED critical/high
  verdict, with zero occurrences of the
  `.suxos-ci/scripts/classify-security-noverdict.sh: No such file or
  directory` error. Stop re-checking #320/#337-blocked PRs for this specific
  cause — if a `security-review` check fails going forward, read its actual
  log output; it's almost certainly a real finding to address, not the old
  infra gap. If the missing-script error ever reappears, it needs a fresh
  issue, not a reopen of these two (their history is long and mostly moot).
- **A suxbot-filed issue about the low-tier dispatcher re-selecting a
  specific blocked issue (e.g. #313 on #264) is usually fixable directly
  from suxlib, without touching `SuxOS/.github`'s reusable
  `issue-build.yml`**: just `gh issue edit <n> --add-label hold` (or
  `needs-human`) on the offending issue. Both labels are already an EXPAND
  exclusion signal this task's own instructions honor ("not already
  labelled `building`/`hold`/`needs-human`"), so the batch dispatcher almost
  certainly honors them the same way — confirmed by #320/#337 themselves,
  which stopped being re-claimed once labelled `needs-human` (#314). Check
  this before assuming a dispatcher-loop meta-issue needs a cross-repo code
  change.
- Update (2026-07-20, various batches, #309/#242/#324/#326/#320/#337): a
  long back-and-forth of re-checking `gh pr checks 241`/`308` (both stuck on
  the #320 missing-script `security-review` gap), re-grepping `main` for
  `snapshotValue`/`releaseCancelled` (still absent), and re-confirming #324
  (needs a design pass)/#326 (needs the `sux` repo, never checked out here)
  as structurally unbuildable from a suxlib-only session, across roughly six
  consecutive daily batches, before #320/#337/#324/#326 were finally labeled
  `needs-human` so the dispatcher would stop re-surfacing them. One
  recurring near-miss worth remembering as a general technique, not a
  historical fact: `git log --oneline --all | grep <name>` walks *every*
  ref, not just `main`, so it can surface a commit that only exists on an
  unmerged PR's remote-tracking branch and looks, via `git show <sha>`,
  exactly like real landed code — always confirm with `git merge-base
  --is-ancestor <sha> origin/main` before trusting a symbol found via
  `--all` actually exists on `main`.

## Cancellation-convention triage saga (#320/#337/#309/#242/#324/#326/#172/#314)

This narrative used to be interleaved inside CLAUDE.md's House-style
"Cancellation convention" entry, which is otherwise a pure code convention —
moved out since it's issue triage, not a fact about current code.

Update: #303 (open PR #308) and #234 (open PR #241) were both stuck on the
same org-level infra gap #320 tracked — `.suxos-ci/scripts/classify-security-noverdict.sh`
missing from the reusable `security-review` workflow, failing closed on every
PR regardless of diff content. #309 (proposing `runGoverned`'s catch use a
neutral-release outcome, matching #303's fix) and #242 (a snapshot-byte budget
guard on #234's `trace: 'full'` feature) were follow-ups to those two
still-unmerged PRs. A prior stale branch (`bot/issue-build-29707704140`, PR
#304, closed unmerged) found #303 actually landed the method as
`releaseCancelled()`, not the `releaseNeutral()` name #309 itself guessed —
don't reimplement a prerequisite speculatively to unblock its follow-up; the
real PR may use different names. #172 (bare-Handle `params` guard)/PR #173
was a third independent instance of the same #320 gap blocking an
otherwise-complete fix. #320 was eventually labeled `needs-human` after two
consecutive daily batches independently rediscovered it as unfixable from
suxlib (the script and its home repo, SuxOS/.github, aren't reachable from
here). #337 (a second, distinct security-review failure mode — shallow
checkout / no merge-base) was labeled `needs-human` on its second independent
confirmation for the same reason. #324 (streaming/chunked domain+Store path)
and #326 (TS/tsconfig convergence with `sux`) were repeatedly dropped across
several batches for structural reasons (#324 needs a design pass; #326 needs
the `sux` repo, never checked out in this session) until also labeled
`needs-human`. #314 (filed after #313 hit the identical dispatcher-reselects-
a-permanently-blocked-issue pattern for #264) confirmed that labelling the
offending issue `hold`/`needs-human` is the actual fix for that meta-pattern,
since both labels are an EXPAND exclusion signal.

Recurring gotcha surfaced during this saga, worth keeping as a general
technique even though the saga itself is resolved: `git log --oneline --all |
grep <name>` walks every ref, not just `main`, so it can surface a commit
that only exists on an unmerged PR's remote-tracking branch and looks, via
`git show <sha>`, exactly like real landed code. Always confirm with `git
merge-base --is-ancestor <sha> origin/main` (or `git log origin/main` without
`--all`) before trusting a symbol/commit found via `--all` actually exists on
`main`.

As of #414 (2026-07-21), the #320/#337 `security-review` missing-script infra
gap itself is confirmed RESOLVED — the 10 most recent `security-review` runs
all pass or fail on a genuine CONFIRMED finding, zero occurrences of the
missing-script error. Both issues are closed.
