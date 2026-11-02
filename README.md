# wmfs/renovate-config

Shared Renovate preset for Tymly repos.

## Use

Each repo's `renovate.json`:

```json
{ "extends": ["github>wmfs/renovate-config"] }
```

Add any repo-specific `packageRules` after `extends`. Rules in the repo's own file override the preset.

## What it does

| Area | Behaviour |
|---|---|
| Schedule | Before 6am Monday (Europe/London). Security updates and `@wmfs/*` updates run at any time |
| Volume | At most 5 open PRs per repo and 2 new PRs per hour |
| Dev dependencies | Minor and patch updates are grouped into one `build(deps-dev)` PR and automerge when CI passes. Dev majors also automerge once approved |
| Runtime dependencies | `build(deps)` PRs, reviewed by `@wmfs/tymly-reviewers` |
| `@wmfs/*` | Minor and patch updates grouped into one PR per repo, with no 3-day wait |
| Majors | Only opened once ticked on the Dependency Dashboard |
| Release age | Third-party updates wait 3 days after publishing (security fixes don't) |
| chai | Held below 5, because 5+ is ESM-only (see sc-34123) |
| dirty-chai | Disabled |
| conventional-changelog-conventionalcommits | Held below 10, because v10+ broke releases in some repos (sc-34125) |
| Security | Labelled `security` and raised straight away |

## Notes

- `{{ secrets.NPM }}` must exist as an **org-level** secret in the Mend Renovate app, so repos that never had the `hostRules` block also get it.
- The `conventional-changelog-conventionalcommits` hold is temporary. Repos already on 10.x keep their version, because Renovate doesn't roll versions back by default. They just stop getting newer ones. Remove the rule once sc-34125 is done.
- Validate changes with `npx --package renovate -- renovate-config-validator --strict default.json`.
