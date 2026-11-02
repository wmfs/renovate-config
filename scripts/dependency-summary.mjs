#!/usr/bin/env node
// Weekly summary of Renovate activity across a GitHub organisation (sc-34113).
//
// Collects open Renovate PRs, Dependency Dashboards and last week's merges,
// then opens a "Dependency summary" issue in this repo and closes last week's.
// Anyone watching the repo (or mentioned via MENTION) gets it by email.
//
// Environment:
//   ORG           organisation to scan (default: wmfs)
//   READ_TOKEN    token that can read PRs, issues and checks across ORG
//   WRITE_TOKEN   token that can create/close issues in GITHUB_REPOSITORY
//   GITHUB_REPOSITORY  owner/name to post the issue in (set by GitHub Actions)
//   MENTION       optional, e.g. "@wmfs/tymly-reviewers" to notify a team
//   DAYS          look-back window for "new" and "merged" (default: 7)
//
// Flags:
//   --dry-run          print the markdown instead of posting
//   --fixture <file>   read data from a JSON file instead of GitHub (for testing)

import fs from 'node:fs'

const ORG = process.env.ORG || 'wmfs'
const READ_TOKEN = process.env.READ_TOKEN
const WRITE_TOKEN = process.env.WRITE_TOKEN
const TARGET_REPO = process.env.GITHUB_REPOSITORY
const MENTION = process.env.MENTION || ''
const DAYS = Number(process.env.DAYS || 7)
const LABEL = 'dependency-summary'
const RENOVATE = 'app/renovate'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const FIXTURE = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null

const now = new Date(process.env.NOW || Date.now())
const since = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000)
const sinceDate = since.toISOString().slice(0, 10)

// ---------------------------------------------------------------- GitHub API

// GitHub returns an HTML error page (not JSON) when a query times out (502/504)
// or hits a secondary rate limit, so retry those with a back-off.
async function gql (query, variables, attempt = 1) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${READ_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (e) { /* HTML error page */ }

  const retryable = !json || res.status >= 500 || res.status === 403 || res.status === 429
  if (retryable && attempt < 5) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || attempt * 5000
    console.error(`GitHub returned ${res.status}${json ? '' : ' (non-JSON)'}; retrying in ${wait / 1000}s (attempt ${attempt + 1} of 5)`)
    await new Promise(resolve => setTimeout(resolve, wait))
    return gql(query, variables, attempt + 1)
  }
  if (!json) throw new Error(`GitHub returned ${res.status} with a non-JSON body: ${text.slice(0, 200)}`)
  if (!res.ok || json.errors) throw new Error(`GraphQL error (${res.status}): ${JSON.stringify(json.errors || json)}`)
  return json.data
}

const PR_FIELDS = `
  ... on PullRequest {
    number title url createdAt mergedAt mergeable reviewDecision
    repository { name }
    labels(first: 20) { nodes { name } }
    autoMergeRequest { enabledAt }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`

// Merged PRs only need enough to list them, which keeps the query light
const MERGED_FIELDS = `
  ... on PullRequest { title url mergedAt repository { name } }`

const ISSUE_FIELDS = `
  ... on Issue { number url body repository { name } }`

async function search (q, fields, pageSize = 50) {
  const query = `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: ${pageSize}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }`
  const nodes = []
  let after = null
  do {
    const { search } = await gql(query, { q, after })
    nodes.push(...search.nodes)
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
  } while (after)
  return nodes
}

async function rest (method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${WRITE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok && res.status !== 422) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

async function collect () {
  if (FIXTURE) return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  // One at a time: running these in parallel is what trips GitHub's timeouts
  // and secondary rate limits
  const openPrs = await search(`org:${ORG} is:pr is:open author:${RENOVATE} archived:false`, PR_FIELDS)
  const mergedPrs = await search(`org:${ORG} is:pr is:merged author:${RENOVATE} merged:>=${sinceDate}`, MERGED_FIELDS, 100)
  const dashboards = await search(`org:${ORG} is:issue is:open author:${RENOVATE} archived:false in:title "Dependency Dashboard"`, ISSUE_FIELDS, 25)
  console.error(`Found ${openPrs.length} open PRs, ${mergedPrs.length} merged in the last ${DAYS} days, ${dashboards.length} dashboards`)
  return { openPrs, mergedPrs, dashboards }
}

// ---------------------------------------------------------------- Classify

function classify (pr) {
  const labels = (pr.labels?.nodes || []).map(l => l.name)
  const ci = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null
  const ageDays = Math.floor((now - new Date(pr.createdAt)) / 86400000)
  const security = labels.includes('security') || /\[security\]/i.test(pr.title)
  const runtime = labels.includes('dependencies') || /^build\(deps\):/.test(pr.title)
  const failing = ci === 'FAILURE' || ci === 'ERROR'
  const conflicted = pr.mergeable === 'CONFLICTING'

  let action = null
  if (failing) action = 'failing'
  else if (conflicted) action = 'conflict'
  else if (!ci) action = 'nochecks'
  else if (runtime && pr.reviewDecision !== 'APPROVED') action = 'review'
  else if (ageDays > 7) action = 'stuck'

  return { ...pr, repo: pr.repository.name, labels, ci, ageDays, security, isNew: new Date(pr.createdAt) >= since, action }
}

// Renovate lists majors waiting for approval under "## Pending Approval" as
// " - [ ] <!-- approve-branch=... -->title" (note the leading space)
function pendingApprovals (dashboard) {
  const section = (dashboard.body || '').split(/^## /m).find(s => s.startsWith('Pending Approval'))
  if (!section) return []
  return [...section.matchAll(/^\s*- \[ \] <!-- approve-branch=[^>]*-->(.+)$/gm)].map(m => m[1].trim())
}

// ---------------------------------------------------------------- Markdown

const ciLabel = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'error', PENDING: 'running', EXPECTED: 'waiting' }

function prLine (pr, { showRepo = true } = {}) {
  const bits = [`[${pr.title}](${pr.url})`]
  if (showRepo) bits.unshift(`**${pr.repo}**`)
  bits.push(`(${pr.ci ? ciLabel[pr.ci] || pr.ci.toLowerCase() : 'no checks'}, ${pr.ageDays}d old)`)
  return `- ${bits.join(' ')}`
}

function byRepo (prs) {
  const groups = new Map()
  for (const pr of prs.sort((a, b) => a.repo.localeCompare(b.repo))) {
    if (!groups.has(pr.repo)) groups.set(pr.repo, [])
    groups.get(pr.repo).push(pr)
  }
  return groups
}

function details (summary, lines, openByDefault = false) {
  if (!lines.length) return ''
  return `<details${openByDefault ? ' open' : ''}><summary>${summary}</summary>\n\n${lines.join('\n')}\n\n</details>\n`
}

function render ({ openPrs, mergedPrs, dashboards }) {
  const open = openPrs.map(classify)
  const merged = mergedPrs.map(pr => ({ ...pr, repo: pr.repository.name }))
  const security = open.filter(p => p.security)
  const action = open.filter(p => p.action && !p.security)
  const majors = dashboards
    .map(d => ({ repo: d.repository.name, url: d.url, items: pendingApprovals(d) }))
    .filter(d => d.items.length)
    .sort((a, b) => a.repo.localeCompare(b.repo))
  const majorCount = majors.reduce((n, d) => n + d.items.length, 0)

  const groups = {
    failing: ['Failing CI', 'Fix the build or close the PR.'],
    conflict: ['Merge conflicts', 'Tick "rebase/retry" on the PR.'],
    nochecks: ['No CI checks', "CI didn't run, so Renovate can't automerge."],
    review: ['Waiting for review', 'Runtime dependency updates need an approval.'],
    stuck: ['Passing but not merged after 7+ days', 'Automerge may be blocked: check branch protection and the Renovate job log.']
  }

  const out = []
  out.push(`Renovate summary for the **${ORG}** organisation, week commencing ${now.toISOString().slice(0, 10)}.`)
  if (MENTION) out.push(`\n${MENTION}`)
  out.push('')
  out.push('| | Count |')
  out.push('|---|---|')
  out.push(`| Open security PRs | ${security.length} (${security.filter(p => p.isNew).length} new) |`)
  out.push(`| Other PRs needing action | ${action.length} |`)
  out.push(`| Majors waiting for approval | ${majorCount} in ${majors.length} repos |`)
  out.push(`| Merged in the last ${DAYS} days | ${merged.length} |`)
  out.push(`| All open Renovate PRs | ${open.length} |`)
  out.push('')

  out.push('## Security')
  if (!security.length) out.push('No open security PRs.')
  else {
    const fresh = security.filter(p => p.isNew)
    const older = security.filter(p => !p.isNew)
    if (fresh.length) out.push(`**New this week**\n\n${fresh.map(p => prLine(p)).join('\n')}\n`)
    if (older.length) out.push(`**Still open**\n\n${older.sort((a, b) => b.ageDays - a.ageDays).map(p => prLine(p)).join('\n')}`)
  }
  out.push('')

  out.push('## Needs action')
  if (!action.length) out.push('Nothing waiting.')
  for (const [key, [title, hint]] of Object.entries(groups)) {
    const prs = action.filter(p => p.action === key)
    if (!prs.length) continue
    out.push(`### ${title} (${prs.length})\n${hint}\n`)
    for (const [repo, list] of byRepo(prs)) {
      out.push(`**${repo}**\n${list.map(p => prLine(p, { showRepo: false })).join('\n')}\n`)
    }
  }
  out.push('')

  out.push('## Majors waiting for approval')
  if (!majors.length) out.push('None.')
  else {
    out.push('Tick one on the repo\'s Dependency Dashboard to have Renovate open the PR.\n')
    out.push(details(`${majorCount} majors in ${majors.length} repos`,
      majors.map(d => `- **[${d.repo}](${d.url})**: ${d.items.join('; ')}`)))
  }
  out.push('')

  out.push(`## Merged in the last ${DAYS} days`)
  if (!merged.length) out.push('Nothing merged.')
  else {
    const lines = [...byRepo(merged)].map(([repo, list]) =>
      `- **${repo}** (${list.length}): ${list.map(p => `[${p.title.replace(/^build\((deps|deps-dev)\): /, '')}](${p.url})`).join('; ')}`)
    out.push(details(`${merged.length} PRs in ${byRepo(merged).size} repos`, lines))
  }

  out.push('\n---\nGenerated by `scripts/dependency-summary.mjs` in wmfs/renovate-config. Last week\'s summary is closed automatically.')
  return out.join('\n')
}

// ---------------------------------------------------------------- Post

async function post (title, body) {
  const [owner, repo] = TARGET_REPO.split('/')
  await rest('POST', `/repos/${owner}/${repo}/labels`, { name: LABEL, color: '0e8a16', description: 'Weekly Renovate summary' })
  const previous = await rest('GET', `/repos/${owner}/${repo}/issues?state=open&labels=${LABEL}&per_page=100`)
  const issue = await rest('POST', `/repos/${owner}/${repo}/issues`, { title, body, labels: [LABEL] })
  for (const old of previous) {
    await rest('POST', `/repos/${owner}/${repo}/issues/${old.number}/comments`, { body: `Superseded by #${issue.number}.` })
    await rest('PATCH', `/repos/${owner}/${repo}/issues/${old.number}`, { state: 'closed', state_reason: 'completed' })
  }
  console.log(`Posted ${issue.html_url}`)
}

const data = await collect()
const title = `Dependency summary: w/c ${now.toISOString().slice(0, 10)}`
const body = render(data)

if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# ${title}\n\n${body}\n`)

if (DRY_RUN) {
  console.log(`# ${title}\n\n${body}`)
} else {
  if (!READ_TOKEN || !WRITE_TOKEN || !TARGET_REPO) throw new Error('READ_TOKEN, WRITE_TOKEN and GITHUB_REPOSITORY are required')
  await post(title, body)
}
