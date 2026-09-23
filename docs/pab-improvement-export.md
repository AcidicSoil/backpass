# Reuse Backpass evidence as PAB improvement fuel

Backpass keeps a saved proposal in the repository-local `.backpass/proposal.json`. From the correction repository:

```sh
backpass improvements --json
backpass improvements --pab-url http://127.0.0.1:<PAB_PORT>
```

Without an opted-in URL, `backpass improvements --json` prints the incident array with no network call. Supplying `--pab-url` or `BACKPASS_PAB_URL` opts into loopback-only HTTP POST. The environment variable also enables fail-soft publishing for new `backpass` and `backpass propose` runs after the proposal is saved. A manual delivery failure returns a nonzero exit code; the saved proposal remains available for retry. Saved-proposal export never calls a Backpass model or edits target files.

Each incident contains a deterministic content-derived ID, original evidence, a correction derived from measured file changes or an extracted skill, the canonical Git repository, and existing safe repo-relative file targets. Revised content receives a new ID instead of colliding with PAB's immutable content digest. Rejected proposals, evidence-free edits, unsafe or missing targets, and user-scope/shared-system corrections are skipped. With publishing enabled, an empty JSON export returns `{ "sent": 0, "receipts": [] }`. PAB's investigation uses its configured local workspace model and does not grant implementation authority.

After matching, review the resulting improvement in the PAB workspace. Approval creates a PAO proposed objective through the existing v1 contract. Implementation and verified adoption are separate states: do not treat successful HTTP delivery as execution authorization.

To remove paid Backpass analysis/synthesis costs for **new** runs, configure a supported local-model agent and verify both analysis and synthesis on a small bounded corpus first. This exporter alone does not convert Backpass's model execution to local inference. Never rely on the words _local-first_ as proof that inference is local.
