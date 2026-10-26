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
| Security | Labelled `security` and raised straight away |

## Notes

- `{{ secrets.NPM }}` must exist as an **org-level** secret in the Mend Renovate app, so repos that never had the `hostRules` block also get it.
- Repo-specific `conventional-changelog-conventionalcommits` limits (tymly-relay-plugin `<10`, tymly-rbac-plugin `<10.4.0`) aren't in the preset. 91 repos already run 10.4.1, so keep those limits in the two repos' own `renovate.json` files.
- Validate changes with `npx --package renovate -- renovate-config-validator --strict default.json`.
