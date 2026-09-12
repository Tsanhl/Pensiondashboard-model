# Public code synchronization

The owner explicitly selected `https://github.com/Tsanhl/Pensiondashboard-model.git`
as the target for this and subsequent requested pushes on 12 September 2026.
This supersedes the historical contract's prohibition on changing to that remote
for Git delivery only. It grants no model promotion, deployment or unseen access.

The public repository and private working project have different Git histories.
Never push the private working branch or use `--all`, `--mirror` or force push.
The owner's latest instruction is direct synchronization to remote `main`,
including deleted files, without a pull request. New commits retain the existing
public history as their parent. The local `codex/public-latest` ref holds the
public snapshot; the working branch, local main, index and private assets are not replaced.

For each requested update, run the safe development tests, inspect the source
allowlist with `node scripts/syncPublicCode.mjs`, then publish with
`node scripts/syncPublicCode.mjs --publish`. A plain `git push` does not collect
new working-directory edits; use the synchronization command for fresh code.
Review the allowlist when adding new source locations. The dry run lists remote
files removed by the exact public snapshot. They remain recoverable in Git history.

Included: current application, training/recovery and qualification-controller
source, SQL migrations, project documentation and status summaries, public corpus
manifests, development tests and the supplied synthetic visible PDU50 pack, with
product messages, harness setup and evaluator material in separate files.
Excluded: private workspace ancestry, personal course inventories, raw traces,
reviewer execution/authentication artifacts, local corpus stores, weights,
protected training/evaluation banks and sealed unseen material. Local asset
references in source are not claims that those assets ship in this repository.
Some integration tests require the separately provisioned local approved corpus.

## Development state at synchronization

The latest bounded training run completed 12 updates; durable lineage is 31.
On the same eight visible development questions, baseline checkpoint 104 passed
1/8, the parent passed 2/8, and the latest candidate passed 5/8 under dual review.
Three candidate cases remain below full PASS. No candidate was promoted;
checkpoint 104 is preserved. This is not browser acceptance or formal
qualification. PDU50 readiness and product acceptance remain incomplete.
