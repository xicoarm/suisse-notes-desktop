# Required desktop CI gate

The required check is `build-validation`, produced by GitHub Actions. It runs
even when its lint/test dependency fails or is cancelled, and explicitly fails
in that case. A skipped build is not evidence that tests passed. Keep this job
name stable when changing the test platform matrix.

The repository owner owns infrastructure failures; the change author fixes
product failures. Preserve the first failure and do not repeatedly rerun until
green. Investigate a broken main check within one working day. Do not silently
quarantine recording or upload regressions.

Main requires up-to-date passing checks, including for administrators. Force
pushes and branch deletion remain disabled. No extra human-review requirement
is introduced by this gate.

For a release, prepare version and changelog changes on a branch, have that
exact candidate pass CI, then merge through a PR. Create and push the release
tag only after main contains the release commit and its checks pass. If a local
release helper creates a tag while preparing the branch, keep it local until
its commit is the verified main release commit; a squash merge changes the SHA.
Do not push a release tag from the candidate branch or bypass protection for
an unchecked version bump. The existing signing, clean-tree, public-SHA and
both-platform release verification requirements still apply.

This gate validates lint, unit tests and the SPA build. It does not claim to
qualify microphone permission, system audio capture, installation, signing or
auto-update on a real operating system. Keep manual release checks for those.
