// `gh` in the bash tool, behaving like GitHub's CLI (its non-interactive output, --json/--jq, -R) so models can
// use what they know: pull requests, issues, Actions runs, releases, `gh api`.
//
// env: { gh(path, opts), repo: { owner, name } | null (the cwd repo's origin), branch (current) | null,
//        login(), approve(req) (the UI's card; absent when no one can answer), exec(cmd, { stdin }) (jq),
//        git(argv) (gitcli, for pr checkout), call(tool, args), isStorage(owner, name), storageName }
// Writes that change a default branch or can't be undone (pr merge, deleting a branch, any `gh api` that isn't a
// read) ask the user first; the answer only ever comes from the card. The storage repo is never reachable.
import { parseArgs } from './gitcli.js';

const ok = (stdout = '') => ({ stdout: stdout && !stdout.endsWith('\n') ? stdout + '\n' : stdout, stderr: '', exitCode: 0 });
const fail = (stderr, exitCode = 1) => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', exitCode });
class GhError extends Error {}

const enc = (s) => encodeURIComponent(s);
const upper = (s) => String(s || '').toUpperCase();

// ── JSON fields, named as gh names them ────────────────────────────────────

const user = (u) => (u ? { login: u.login } : null);
const prState = (p) => (p.merged_at ? 'MERGED' : upper(p.state));
const PR_FIELDS = {
  number: p => p.number, title: p => p.title, body: p => p.body || '', state: prState, url: p => p.html_url,
  headRefName: p => p.head && p.head.ref, baseRefName: p => p.base && p.base.ref, headRefOid: p => p.head && p.head.sha,
  author: p => user(p.user), createdAt: p => p.created_at, updatedAt: p => p.updated_at, closedAt: p => p.closed_at,
  mergedAt: p => p.merged_at, isDraft: p => Boolean(p.draft), labels: p => (p.labels || []).map(l => ({ name: l.name })),
  assignees: p => (p.assignees || []).map(user), reviewRequests: p => (p.requested_reviewers || []).map(user),
  mergeable: p => (p.mergeable == null ? 'UNKNOWN' : p.mergeable ? 'MERGEABLE' : 'CONFLICTING'),
  additions: p => p.additions, deletions: p => p.deletions, changedFiles: p => p.changed_files, id: p => p.node_id,
  milestone: p => (p.milestone ? { title: p.milestone.title } : null), isCrossRepository: p => Boolean(p.head && p.base && p.head.repo && p.base.repo && p.head.repo.full_name !== p.base.repo.full_name),
};
const ISSUE_FIELDS = {
  number: i => i.number, title: i => i.title, body: i => i.body || '', state: i => upper(i.state), url: i => i.html_url,
  author: i => user(i.user), createdAt: i => i.created_at, updatedAt: i => i.updated_at, closedAt: i => i.closed_at,
  labels: i => (i.labels || []).map(l => ({ name: l.name })), assignees: i => (i.assignees || []).map(user),
  comments: i => (Array.isArray(i.comments) ? i.comments : { totalCount: i.comments }), id: i => i.node_id,
  milestone: i => (i.milestone ? { title: i.milestone.title } : null), stateReason: i => upper(i.state_reason || ''),
};
const REPO_FIELDS = {
  name: r => r.name, nameWithOwner: r => r.full_name, owner: r => user(r.owner), description: r => r.description || '',
  url: r => r.html_url, isPrivate: r => r.private, visibility: r => upper(r.visibility), defaultBranchRef: r => ({ name: r.default_branch }),
  createdAt: r => r.created_at, updatedAt: r => r.updated_at, pushedAt: r => r.pushed_at, isFork: r => r.fork, isArchived: r => r.archived,
  stargazerCount: r => r.stargazers_count, forkCount: r => r.forks_count, primaryLanguage: r => (r.language ? { name: r.language } : null), homepageUrl: r => r.homepage || '',
};
const RUN_FIELDS = {
  databaseId: r => r.id, name: r => r.name, displayTitle: r => r.display_title, status: r => r.status, conclusion: r => r.conclusion || '',
  workflowName: r => r.name, headBranch: r => r.head_branch, headSha: r => r.head_sha, event: r => r.event, url: r => r.html_url,
  createdAt: r => r.created_at, updatedAt: r => r.updated_at, number: r => r.run_number, attempt: r => r.run_attempt,
};
const RELEASE_FIELDS = {
  tagName: r => r.tag_name, name: r => r.name, body: r => r.body || '', isDraft: r => r.draft, isPrerelease: r => r.prerelease,
  createdAt: r => r.created_at, publishedAt: r => r.published_at, url: r => r.html_url, author: r => user(r.author),
};

// --json a,b[,c] (with --jq to filter): the fields, as gh prints them. Without --json: null.
async function jsonOut(env, o, rows, fields, single = false) {
  if (!o.json) return null;
  if (o.json === true) return fail(`Specify one or more comma-separated fields for \`--json\`:\n  ${Object.keys(fields).sort().join('\n  ')}`);
  const names = String(o.json).split(',').map(s => s.trim()).filter(Boolean);
  const bad = names.filter(n => !fields[n]);
  if (bad.length) return fail(`Unknown JSON field: "${bad[0]}"\nAvailable fields:\n  ${Object.keys(fields).sort().join('\n  ')}`);
  const pick = (x) => Object.fromEntries(names.map(n => [n, fields[n](x)]));
  const data = single ? pick(rows) : rows.map(pick);
  return jqOut(env, o, data);
}
async function jqOut(env, o, data) {
  const text = JSON.stringify(data, null, 2);
  if (!o.q && !o.jq) return ok(text);
  const expr = o.q || o.jq;
  if (!env.exec) return fail('--jq isn\'t available here; pipe the JSON to jq instead');
  const r = await env.exec(`jq -r '${String(expr).replace(/'/g, `'\\''`)}'`, { stdin: text });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function repoOf(env, o) {
  const given = o.R || o.repo;
  let owner, name;
  if (given && given !== true) {
    const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(given);
    if (!m) throw new GhError(`expected the "[HOST/]OWNER/REPO" format, got "${given}"`);
    [owner, name] = [m[1], m[2]];
  } else if (env.repo) ({ owner, name } = env.repo);
  else throw new GhError('could not determine the repository: cd into /repos/<name> or pass -R owner/name');
  if (env.isStorage && env.isStorage(owner, name)) throw new GhError('that is Squiggle\'s storage repo; it isn\'t available to commands');
  return { owner, name, full: `${owner}/${name}`, path: `/repos/${owner}/${name}` };
}
const num = (x) => { const m = /(?:^#?|\/(?:pull|issues)\/)(\d+)\/?$/.exec(String(x || '')); return m ? +m[1] : null; };
const limitOf = (o, d = 30) => Math.max(1, Math.min(1000, +(o.L || o.limit || d) || d));
async function readBody(env, o) {
  if (o.F && o.F !== true && !o['body-file']) o['body-file'] = o.F;
  const file = o['body-file'];
  if (file && file !== true) {
    if (file === '-') return env.stdin || '';
    if (!env.readFile) throw new GhError('--body-file isn\'t available here; pass --body');
    const text = await env.readFile(file);
    if (text == null) throw new GhError(`could not read ${file}`);
    return text;
  }
  const b = o.b !== undefined ? o.b : o.body;
  return b === true ? '' : b;
}
const list = (x) => (x == null || x === true ? [] : (Array.isArray(x) ? x : [x]).flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean));
const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); for (const [n, u] of [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) if (s >= n) { const k = Math.floor(s / n); return `about ${k} ${u}${k === 1 ? '' : 's'} ago`; } return 'less than a minute ago'; };
const dur = (a, b) => { if (!a || !b) return ''; const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`; };

// The PR a command means: a number, a URL, a branch name, or (none) the current branch's.
async function findPr(env, r, arg) {
  const n = num(arg);
  if (n) return env.gh(`${r.path}/pulls/${n}`);
  const branch = arg && arg !== true ? String(arg) : env.branch;
  if (!branch) throw new GhError('could not determine the pull request: give its number');
  const found = await env.gh(`${r.path}/pulls?state=all&head=${enc(`${r.owner}:${branch}`)}&per_page=5`);
  if (!found.length) throw new GhError(`no pull requests found for branch "${branch}"`);
  return env.gh(`${r.path}/pulls/${found[0].number}`);
}
async function ask(env, req) {
  if (typeof env.approve !== 'function') throw new GhError(`${req.title} needs the user's approval, and no one is here to approve it.`);
  const d = await env.approve({ kind: 'action', ...req });
  if (d !== 'once' && d !== 'always') throw new GhError(`The user did not allow this (${req.title}). Don't try again; ask them how they'd like to proceed.`);
}
async function labelsAndPeople(env, r, number, o) {
  const add = list(o.multi['add-label'] || o.multi.label || o.multi.l), remove = list(o.multi['remove-label']);
  if (add.length) await env.gh(`${r.path}/issues/${number}/labels`, { method: 'POST', body: { labels: add } });
  for (const l of remove) await env.gh(`${r.path}/issues/${number}/labels/${enc(l)}`, { method: 'DELETE' }).catch(() => null);
  const me = async (x) => (x === '@me' ? (await env.login()) : x);
  const assignees = await Promise.all(list(o.multi['add-assignee'] || o.multi.assignee || o.multi.a).map(me));
  if (assignees.length) await env.gh(`${r.path}/issues/${number}/assignees`, { method: 'POST', body: { assignees } });
  const unassign = await Promise.all(list(o.multi['remove-assignee']).map(me));
  if (unassign.length) await env.gh(`${r.path}/issues/${number}/assignees`, { method: 'DELETE', body: { assignees: unassign } });
  return { add, assignees };
}

// ── pr ─────────────────────────────────────────────────────────────────────

const pr = {};

pr.list = async (env, o) => {
  const r = repoOf(env, o);
  const state = String(o.s || o.state || 'open').toLowerCase();
  const q = new URLSearchParams({ state: state === 'merged' ? 'closed' : state === 'all' ? 'all' : state, per_page: String(Math.min(100, limitOf(o))), sort: 'created', direction: 'desc' });
  if (o.H || o.head) q.set('head', `${r.owner}:${o.H || o.head}`);
  if (o.B || o.base) q.set('base', o.B || o.base);
  let rows = await env.gh(`${r.path}/pulls?${q}`);
  if (state === 'merged') rows = rows.filter(p => p.merged_at);
  const author = o.A || o.author;
  if (author) { const who = author === '@me' ? await env.login() : author; rows = rows.filter(p => p.user && p.user.login.toLowerCase() === who.toLowerCase()); }
  const labels = list(o.multi.l || o.multi.label);
  if (labels.length) rows = rows.filter(p => labels.every(l => (p.labels || []).some(x => x.name === l)));
  const search = o.S || o.search;
  if (search) { const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); rows = rows.filter(p => re.test(`${p.title}\n${p.body || ''}`)); }
  rows = rows.slice(0, limitOf(o));
  const j = await jsonOut(env, o, rows, PR_FIELDS);
  if (j) return j;
  if (!rows.length) return { stdout: '', stderr: `no ${state === 'all' ? '' : state + ' '}pull requests in ${r.full}\n`, exitCode: 0 };
  return ok(rows.map(p => [p.number, p.title, p.head.ref, prState(p), p.created_at].join('\t')).join('\n'));
};

pr.view = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  if (o.json) {
    if (String(o.json).split(',').includes('comments')) {
      const comments = await env.gh(`${r.path}/issues/${p.number}/comments?per_page=100`);
      const fields = { ...PR_FIELDS, comments: () => comments.map(c => ({ author: user(c.user), body: c.body, createdAt: c.created_at, url: c.html_url })) };
      return jsonOut(env, o, p, fields, true);
    }
    return jsonOut(env, o, p, PR_FIELDS, true);
  }
  if (o.w || o.web) return ok(p.html_url);
  const lines = [
    `title:\t${p.title}`, `state:\t${prState(p)}${p.draft ? ' (draft)' : ''}`, `author:\t${p.user ? p.user.login : ''}`,
    `labels:\t${(p.labels || []).map(l => l.name).join(', ')}`, `assignees:\t${(p.assignees || []).map(a => a.login).join(', ')}`,
    `reviewers:\t${(p.requested_reviewers || []).map(a => a.login).join(', ')}`, `milestone:\t${p.milestone ? p.milestone.title : ''}`,
    `number:\t${p.number}`, `url:\t${p.html_url}`, `base:\t${p.base.ref}`, `head:\t${p.head.ref}`,
    `additions:\t${p.additions ?? ''}`, `deletions:\t${p.deletions ?? ''}`, `mergeable:\t${PR_FIELDS.mergeable(p)}`, '--', p.body || '',
  ];
  if (o.c || o.comments) {
    const comments = await env.gh(`${r.path}/issues/${p.number}/comments?per_page=100`);
    for (const c of comments) lines.push('--', `author:\t${c.user ? c.user.login : ''}`, `date:\t${c.created_at}`, '--', c.body || '');
  }
  return ok(lines.join('\n'));
};

pr.create = async (env, o) => {
  const r = repoOf(env, o);
  if (o.w || o.web) return fail('--web isn\'t available here; gh pr create opens it directly');
  const head = o.H || o.head || env.branch;
  if (!head) throw new GhError('could not determine the current branch; pass --head');
  let title = o.t || o.title, body = await readBody(env, o);
  if ((o.f || o.fill || o['fill-first'] || o['fill-verbose']) && (!title || body == null) && env.git) {
    const log = await env.git(['log', '--format=%s%n%n%b%x00', '-n', '20', head, '--not', `origin/${o.B || o.base || 'HEAD'}`]).catch(() => null);
    const commits = log && log.stdout ? log.stdout.split('\0').map(s => s.trim()).filter(Boolean) : [];
    if (commits.length) {
      if (!title) title = commits[commits.length - 1].split('\n')[0];
      if (body == null) body = commits.length === 1 ? commits[0].split('\n').slice(2).join('\n') : commits.reverse().map(c => `- ${c.split('\n')[0]}`).join('\n');
    }
  }
  if (!title) return fail('must provide `--title` and `--body` (or `--fill`) when not running interactively');
  const info = await env.gh(r.path);
  const base = o.B || o.base || info.default_branch;
  const p = await env.gh(`${r.path}/pulls`, { method: 'POST', body: { title, body: `${body || ''}\n\n_Opened by Squiggle._`.trim(), head, base, draft: Boolean(o.d || o.draft) } });
  await labelsAndPeople(env, r, p.number, o);
  const reviewers = list(o.multi.r || o.multi.reviewer);
  if (reviewers.length) await env.gh(`${r.path}/pulls/${p.number}/requested_reviewers`, { method: 'POST', body: { reviewers } }).catch(() => null);
  return ok(p.html_url);
};

pr.edit = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  const body = await readBody(env, o);
  const patch = {};
  if (o.t || o.title) patch.title = o.t || o.title;
  if (body != null) patch.body = body;
  if (o.B || o.base) patch.base = o.B || o.base;
  if (Object.keys(patch).length) await env.gh(`${r.path}/pulls/${p.number}`, { method: 'PATCH', body: patch });
  await labelsAndPeople(env, r, p.number, o);
  const addR = list(o.multi['add-reviewer']), removeR = list(o.multi['remove-reviewer']);
  if (addR.length) await env.gh(`${r.path}/pulls/${p.number}/requested_reviewers`, { method: 'POST', body: { reviewers: addR } });
  if (removeR.length) await env.gh(`${r.path}/pulls/${p.number}/requested_reviewers`, { method: 'DELETE', body: { reviewers: removeR } });
  return ok(p.html_url);
};

pr.comment = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  const body = await readBody(env, o);
  if (!body) return fail('--body or --body-file required when not running interactively');
  const c = await env.gh(`${r.path}/issues/${p.number}/comments`, { method: 'POST', body: { body } });
  return ok(c.html_url);
};

pr.close = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  if (o['delete-branch'] || o.d) await ask(env, { title: `Delete branch ${p.head.ref} on GitHub (${r.full})`, details: [`Closing PR #${p.number}: ${p.title}`] });
  if (o.c || o.comment) await env.gh(`${r.path}/issues/${p.number}/comments`, { method: 'POST', body: { body: o.c || o.comment } });
  await env.gh(`${r.path}/pulls/${p.number}`, { method: 'PATCH', body: { state: 'closed' } });
  if (o['delete-branch'] || o.d) await env.gh(`${r.path}/git/refs/heads/${p.head.ref.split('/').map(enc).join('/')}`, { method: 'DELETE' });
  return ok(`✓ Closed pull request ${r.full}#${p.number} (${p.title})${o['delete-branch'] || o.d ? `\n✓ Deleted branch ${p.head.ref}` : ''}`);
};

pr.reopen = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  await env.gh(`${r.path}/pulls/${p.number}`, { method: 'PATCH', body: { state: 'open' } });
  return ok(`✓ Reopened pull request ${r.full}#${p.number} (${p.title})`);
};

pr.merge = async (env, o) => {
  const r = repoOf(env, o);
  if (o.auto) return fail('--auto isn\'t available here; merge when the checks pass');
  const p = await findPr(env, r, o._[0]);
  if (p.merged_at) return ok(`! Pull request ${r.full}#${p.number} was already merged`);
  const method = o.s || o.squash ? 'squash' : o.r || o.rebase ? 'rebase' : 'merge';
  await ask(env, { title: `Merge PR #${p.number} into ${p.base.ref} in ${r.full}`, details: [p.title, `${p.head.ref} → ${p.base.ref} (${method})`, ...(o.d || o['delete-branch'] ? [`then delete ${p.head.ref} on GitHub`] : [])] });
  const body = {};
  body.merge_method = method;
  if (o.t || o.subject) body.commit_title = o.t || o.subject;
  const b = await readBody(env, o);
  if (b != null) body.commit_message = b;
  if (o['match-head-commit']) body.sha = o['match-head-commit'];
  await env.gh(`${r.path}/pulls/${p.number}/merge`, { method: 'PUT', body });
  const out = [`✓ ${method === 'squash' ? 'Squashed and merged' : method === 'rebase' ? 'Rebased and merged' : 'Merged'} pull request ${r.full}#${p.number} (${p.title})`];
  if (o.d || o['delete-branch']) {
    await env.gh(`${r.path}/git/refs/heads/${p.head.ref.split('/').map(enc).join('/')}`, { method: 'DELETE' }).catch(() => null);
    out.push(`✓ Deleted branch ${p.head.ref}`);
  }
  return ok(out.join('\n'));
};

pr.diff = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  if (o['name-only']) {
    const files = await env.gh(`${r.path}/pulls/${p.number}/files?per_page=100`);
    return ok(files.map(f => f.filename).join('\n'));
  }
  return ok(await env.gh(`${r.path}/pulls/${p.number}`, { accept: o.patch ? 'application/vnd.github.patch' : 'application/vnd.github.diff', text: true }));
};

pr.checks = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  const runs = (await env.gh(`${r.path}/commits/${p.head.sha}/check-runs?per_page=100`)).check_runs || [];
  const statuses = (await env.gh(`${r.path}/commits/${p.head.sha}/status`)).statuses || [];
  const rows = [
    ...runs.map(c => ({ name: c.name, state: c.status !== 'completed' ? 'pending' : ({ success: 'pass', neutral: 'pass', skipped: 'skipping', cancelled: 'fail', timed_out: 'fail', action_required: 'fail', failure: 'fail' })[c.conclusion] || c.conclusion, time: dur(c.started_at, c.completed_at), url: c.html_url })),
    ...statuses.map(s => ({ name: s.context, state: ({ success: 'pass', failure: 'fail', error: 'fail', pending: 'pending' })[s.state] || s.state, time: '', url: s.target_url || '' })),
  ];
  if (o.json) return jsonOut(env, o, rows, { name: x => x.name, state: x => upper(x.state), bucket: x => x.state, link: x => x.url });
  if (!rows.length) return fail(`no checks reported on the '${p.head.ref}' branch`);
  const failed = rows.some(x => x.state === 'fail'), pending = rows.some(x => x.state === 'pending');
  return { stdout: rows.map(x => [x.name, x.state, x.time, x.url].join('\t')).join('\n') + '\n', stderr: '', exitCode: failed ? 1 : pending ? 8 : 0 };
};

pr.status = async (env, o) => {
  const r = repoOf(env, o);
  const me = await env.login();
  const out = [`Relevant pull requests in ${r.full}`, '', 'Current branch'];
  if (env.branch) {
    const mine = await env.gh(`${r.path}/pulls?state=all&head=${enc(`${r.owner}:${env.branch}`)}&per_page=1`);
    out.push(mine.length ? `  #${mine[0].number}  ${mine[0].title} [${env.branch}] - ${prState(mine[0])}` : `  There is no pull request associated with [${env.branch}]`);
  } else out.push('  (not on a branch)');
  const created = await env.gh(`/search/issues?q=${enc(`is:pr is:open author:${me} repo:${r.full}`)}&per_page=10`);
  out.push('', 'Created by you', ...(created.items.length ? created.items.map(i => `  #${i.number}  ${i.title}`) : ['  You have no open pull requests']));
  const review = await env.gh(`/search/issues?q=${enc(`is:pr is:open review-requested:${me} repo:${r.full}`)}&per_page=10`);
  out.push('', 'Requesting a code review from you', ...(review.items.length ? review.items.map(i => `  #${i.number}  ${i.title}`) : ['  You have no pull requests to review']));
  return ok(out.join('\n'));
};

pr.checkout = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  if (!env.git) return fail('gh pr checkout needs a cloned repo: cd into /repos/<name>');
  const f = await env.git(['fetch', 'origin', p.head.ref]);
  if (f.exitCode) return f;
  return env.git(['switch', p.head.ref]);
};

pr.ready = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  const mutation = o.undo ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
  await env.gh('/graphql', { method: 'POST', body: { query: `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, variables: { id: p.node_id } } });
  return ok(o.undo ? `✓ Pull request ${r.full}#${p.number} is converted to "draft"` : `✓ Pull request ${r.full}#${p.number} is marked as "ready for review"`);
};

pr.review = async (env, o) => {
  const r = repoOf(env, o);
  const p = await findPr(env, r, o._[0]);
  const event = o.a || o.approve ? 'APPROVE' : o.r || o['request-changes'] ? 'REQUEST_CHANGES' : 'COMMENT';
  const body = await readBody(env, o);
  if (event !== 'APPROVE' && !body) return fail('a body is required for this review (--body)');
  await env.gh(`${r.path}/pulls/${p.number}/reviews`, { method: 'POST', body: { event, ...(body ? { body } : {}) } });
  return ok(`✓ ${event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Requested changes to' : 'Reviewed'} pull request ${r.full}#${p.number}`);
};

// ── issue ──────────────────────────────────────────────────────────────────

const issue = {};
async function findIssue(env, r, arg) {
  const n = num(arg);
  if (!n) throw new GhError('give the issue number');
  const i = await env.gh(`${r.path}/issues/${n}`);
  if (i.pull_request) throw new GhError(`#${n} is a pull request: use gh pr`);
  return i;
}

issue.list = async (env, o) => {
  const r = repoOf(env, o);
  const state = String(o.s || o.state || 'open').toLowerCase();
  const q = new URLSearchParams({ state, per_page: String(Math.min(100, limitOf(o) * 2)) });
  const labels = list(o.multi.l || o.multi.label);
  if (labels.length) q.set('labels', labels.join(','));
  if (o.a || o.assignee) q.set('assignee', (o.a || o.assignee) === '@me' ? await env.login() : (o.a || o.assignee));
  if (o.A || o.author) q.set('creator', (o.A || o.author) === '@me' ? await env.login() : (o.A || o.author));
  let rows = (await env.gh(`${r.path}/issues?${q}`)).filter(i => !i.pull_request);
  const search = o.S || o.search;
  if (search) { const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); rows = rows.filter(i => re.test(`${i.title}\n${i.body || ''}`)); }
  rows = rows.slice(0, limitOf(o));
  const j = await jsonOut(env, o, rows, ISSUE_FIELDS);
  if (j) return j;
  if (!rows.length) return { stdout: '', stderr: `no ${state === 'all' ? '' : state + ' '}issues in ${r.full}\n`, exitCode: 0 };
  return ok(rows.map(i => [i.number, upper(i.state), i.title, (i.labels || []).map(l => l.name).join(', '), i.updated_at].join('\t')).join('\n'));
};

issue.view = async (env, o) => {
  const r = repoOf(env, o);
  const i = await findIssue(env, r, o._[0]);
  if (o.json) {
    const fields = String(o.json).split(',').includes('comments')
      ? { ...ISSUE_FIELDS, comments: () => null } : ISSUE_FIELDS;
    if (fields !== ISSUE_FIELDS) {
      const comments = await env.gh(`${r.path}/issues/${i.number}/comments?per_page=100`);
      fields.comments = () => comments.map(c => ({ author: user(c.user), body: c.body, createdAt: c.created_at, url: c.html_url }));
    }
    return jsonOut(env, o, i, fields, true);
  }
  if (o.w || o.web) return ok(i.html_url);
  const lines = [`title:\t${i.title}`, `state:\t${upper(i.state)}`, `author:\t${i.user ? i.user.login : ''}`, `labels:\t${(i.labels || []).map(l => l.name).join(', ')}`,
    `comments:\t${i.comments}`, `assignees:\t${(i.assignees || []).map(a => a.login).join(', ')}`, `milestone:\t${i.milestone ? i.milestone.title : ''}`, `number:\t${i.number}`, `url:\t${i.html_url}`, '--', i.body || ''];
  if (o.c || o.comments) {
    for (const c of await env.gh(`${r.path}/issues/${i.number}/comments?per_page=100`)) lines.push('--', `author:\t${c.user ? c.user.login : ''}`, `date:\t${c.created_at}`, '--', c.body || '');
  }
  return ok(lines.join('\n'));
};

issue.create = async (env, o) => {
  const r = repoOf(env, o);
  const title = o.t || o.title;
  const body = await readBody(env, o);
  if (!title) return fail('must provide `--title` and `--body` when not running interactively');
  const i = await env.gh(`${r.path}/issues`, { method: 'POST', body: { title, body: body || '' } });
  await labelsAndPeople(env, r, i.number, o);
  return ok(i.html_url);
};

issue.edit = async (env, o) => {
  const r = repoOf(env, o);
  const i = await findIssue(env, r, o._[0]);
  const body = await readBody(env, o);
  const patch = {};
  if (o.t || o.title) patch.title = o.t || o.title;
  if (body != null) patch.body = body;
  if (Object.keys(patch).length) await env.gh(`${r.path}/issues/${i.number}`, { method: 'PATCH', body: patch });
  await labelsAndPeople(env, r, i.number, o);
  return ok(i.html_url);
};

issue.comment = async (env, o) => {
  const r = repoOf(env, o);
  const i = await findIssue(env, r, o._[0]);
  const body = await readBody(env, o);
  if (!body) return fail('--body or --body-file required when not running interactively');
  const c = await env.gh(`${r.path}/issues/${i.number}/comments`, { method: 'POST', body: { body } });
  return ok(c.html_url);
};

issue.close = async (env, o) => {
  const r = repoOf(env, o);
  const i = await findIssue(env, r, o._[0]);
  if (o.c || o.comment) await env.gh(`${r.path}/issues/${i.number}/comments`, { method: 'POST', body: { body: o.c || o.comment } });
  const reason = /not.?planned/i.test(String(o.r || o.reason || '')) ? 'not_planned' : 'completed';
  await env.gh(`${r.path}/issues/${i.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: reason } });
  return ok(`✓ Closed issue ${r.full}#${i.number} (${i.title})`);
};

issue.reopen = async (env, o) => {
  const r = repoOf(env, o);
  const i = await findIssue(env, r, o._[0]);
  await env.gh(`${r.path}/issues/${i.number}`, { method: 'PATCH', body: { state: 'open' } });
  return ok(`✓ Reopened issue ${r.full}#${i.number} (${i.title})`);
};

// ── repo, run, workflow, release, search, api, auth ────────────────────────

const repo = {};
repo.list = async (env, o) => {
  const res = await env.call('github_list_repos', {});
  if (res.model && res.model.error) return fail(res.model.error);
  let rows = (res.model.repos || []).map(x => ({ full_name: x.repo, name: x.repo.split('/')[1], owner: { login: x.repo.split('/')[0] }, description: String(x.description || '').replace(/<\/?untrusted[^>]*>\n?/g, '').trim(), private: x.private, visibility: x.private ? 'private' : 'public', default_branch: x.default_branch, html_url: `https://github.com/${x.repo}` }));
  const owner = o._[0];
  if (owner) rows = rows.filter(x => x.owner.login.toLowerCase() === owner.toLowerCase());
  if (o.visibility) rows = rows.filter(x => x.visibility === o.visibility);
  rows = rows.slice(0, limitOf(o));
  const j = await jsonOut(env, o, rows, REPO_FIELDS);
  if (j) return j;
  return ok(rows.map(x => [x.full_name, x.description, x.private ? 'private' : 'public'].join('\t')).join('\n'));
};
repo.view = async (env, o) => {
  const r = repoOf(env, o._[0] ? { ...o, R: o._[0] } : o);
  const info = await env.gh(r.path);
  const j = await jsonOut(env, o, info, REPO_FIELDS, true);
  if (j) return j;
  if (o.w || o.web) return ok(info.html_url);
  let readme = '';
  try { const rd = await env.gh(`${r.path}/readme`); readme = typeof atob === 'function' ? new TextDecoder().decode(Uint8Array.from(atob(rd.content.replace(/\n/g, '')), ch => ch.charCodeAt(0))) : ''; } catch { readme = ''; }
  return ok([`name:\t${info.full_name}`, `description:\t${info.description || ''}`, `default branch:\t${info.default_branch}`, `visibility:\t${info.visibility || (info.private ? 'private' : 'public')}`, `url:\t${info.html_url}`, '--', readme].join('\n'));
};
repo.clone = async (env, o) => {
  if (!o._[0]) return fail('cannot clone: repository argument required');
  const res = await env.call('git_clone', { repo: o._[0] });
  if (res.model && res.model.error) return fail(res.model.error);
  return { stdout: '', stderr: `Cloning into '${res.model.path}'...\n`, exitCode: 0 };
};

const run = {};
run.list = async (env, o) => {
  const r = repoOf(env, o);
  const q = new URLSearchParams({ per_page: String(Math.min(100, limitOf(o, 20))) });
  if (o.b || o.branch) q.set('branch', o.b || o.branch);
  if (o.s || o.status) q.set('status', o.s || o.status);
  if (o.e || o.event) q.set('event', o.e || o.event);
  if (o.u || o.user) q.set('actor', o.u || o.user);
  const path = o.w || o.workflow ? `${r.path}/actions/workflows/${enc(o.w || o.workflow)}/runs` : `${r.path}/actions/runs`;
  const rows = ((await env.gh(`${path}?${q}`)).workflow_runs || []).slice(0, limitOf(o, 20));
  const j = await jsonOut(env, o, rows, RUN_FIELDS);
  if (j) return j;
  if (!rows.length) return { stdout: '', stderr: `no runs found in ${r.full}\n`, exitCode: 0 };
  return ok(rows.map(x => [x.status, x.conclusion || '', x.display_title, x.name, x.head_branch, x.event, x.id, dur(x.run_started_at || x.created_at, x.updated_at), x.created_at].join('\t')).join('\n'));
};
run.view = async (env, o) => {
  const r = repoOf(env, o);
  let id = o._[0];
  if (!id) { const latest = (await env.gh(`${r.path}/actions/runs?per_page=1${env.branch ? `&branch=${enc(env.branch)}` : ''}`)).workflow_runs || []; if (!latest.length) return fail('no runs found'); id = latest[0].id; }
  const x = await env.gh(`${r.path}/actions/runs/${id}`);
  const jobs = (await env.gh(`${r.path}/actions/runs/${id}/jobs?per_page=100`)).jobs || [];
  const j = await jsonOut(env, o, { ...x, jobs }, { ...RUN_FIELDS, jobs: v => v.jobs.map(jb => ({ name: jb.name, status: jb.status, conclusion: jb.conclusion || '', steps: (jb.steps || []).map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion || '' })) })) }, true);
  if (j) return j;
  const out = [`${x.conclusion === 'success' ? '✓' : x.conclusion ? 'X' : '*'} ${x.head_branch} ${x.name} · ${x.id}`, `Triggered via ${x.event} ${ago(x.created_at)}`, '', 'JOBS'];
  for (const jb of jobs) {
    out.push(`${jb.conclusion === 'success' ? '✓' : jb.conclusion ? 'X' : '*'} ${jb.name} in ${dur(jb.started_at, jb.completed_at)} (ID ${jb.id})`);
    if (o.v || o.verbose || jb.conclusion === 'failure') for (const s of jb.steps || []) out.push(`  ${s.conclusion === 'success' ? '✓' : s.conclusion === 'skipped' ? '-' : s.conclusion ? 'X' : '*'} ${s.name}`);
  }
  if (o.log || o['log-failed']) out.push('', '(Logs aren\'t available here; the steps above show what failed.)');
  out.push('', `View this run on GitHub: ${x.html_url}`);
  return ok(out.join('\n'));
};
run.rerun = async (env, o) => {
  const r = repoOf(env, o);
  const id = o._[0];
  if (!id) return fail('give the run id (gh run list)');
  await env.gh(`${r.path}/actions/runs/${id}/${o.failed ? 'rerun-failed-jobs' : 'rerun'}`, { method: 'POST' });
  return ok(`✓ Requested rerun of run ${id}`);
};
const workflow = {};
workflow.list = async (env, o) => {
  const r = repoOf(env, o);
  const rows = (await env.gh(`${r.path}/actions/workflows?per_page=100`)).workflows || [];
  const j = await jsonOut(env, o, rows, { id: w => w.id, name: w => w.name, path: w => w.path, state: w => w.state });
  if (j) return j;
  return ok(rows.map(w => [w.name, w.state, w.id].join('\t')).join('\n'));
};
const release = {};
release.list = async (env, o) => {
  const r = repoOf(env, o);
  const rows = (await env.gh(`${r.path}/releases?per_page=${Math.min(100, limitOf(o))}`)).slice(0, limitOf(o));
  const j = await jsonOut(env, o, rows, RELEASE_FIELDS);
  if (j) return j;
  return ok(rows.map((x, i) => [x.name || x.tag_name, i === 0 && !x.draft && !x.prerelease ? 'Latest' : x.draft ? 'Draft' : x.prerelease ? 'Pre-release' : '', x.tag_name, x.published_at || x.created_at].join('\t')).join('\n'));
};
release.view = async (env, o) => {
  const r = repoOf(env, o);
  const x = o._[0] ? await env.gh(`${r.path}/releases/tags/${enc(o._[0])}`) : await env.gh(`${r.path}/releases/latest`);
  const j = await jsonOut(env, o, x, RELEASE_FIELDS, true);
  if (j) return j;
  return ok([`title:\t${x.name || x.tag_name}`, `tag:\t${x.tag_name}`, `draft:\t${x.draft}`, `prerelease:\t${x.prerelease}`, `author:\t${x.author ? x.author.login : ''}`, `created:\t${x.created_at}`, `published:\t${x.published_at || ''}`, `url:\t${x.html_url}`, '--', x.body || ''].join('\n'));
};
const search = {};
const searchKind = (kind) => async (env, o) => {
  const terms = o._.join(' ');
  if (env.storageName && terms.toLowerCase().includes(env.storageName.toLowerCase())) throw new GhError('that is Squiggle\'s storage repo; it isn\'t available to commands');
  const qualifiers = kind === 'prs' ? ' is:pr' : kind === 'issues' ? ' is:issue' : '';
  const extra = [o.repo && o.repo !== true ? ` repo:${o.repo}` : '', o.owner ? ` user:${o.owner}` : '', o.state ? ` state:${o.state}` : '', o.language ? ` language:${o.language}` : ''].join('');
  const res = await env.gh(`/search/${kind === 'repos' ? 'repositories' : 'issues'}?q=${enc(terms + qualifiers + extra)}&per_page=${Math.min(100, limitOf(o))}`);
  const items = (res.items || []).filter(x => !(env.isStorage && x.full_name && env.isStorage(...x.full_name.split('/'))));
  if (kind === 'repos') {
    const j = await jsonOut(env, o, items, { ...REPO_FIELDS, fullName: x => x.full_name });
    if (j) return j;
    return ok(items.map(x => [x.full_name, x.description || '', x.private ? 'private' : 'public', x.updated_at].join('\t')).join('\n'));
  }
  const j = await jsonOut(env, o, items, { ...ISSUE_FIELDS, repository: x => ({ nameWithOwner: x.repository_url.split('/repos/')[1] }) });
  if (j) return j;
  return ok(items.map(x => [x.repository_url.split('/repos/')[1], x.number, upper(x.state), x.title, x.updated_at].join('\t')).join('\n'));
};
search.repos = searchKind('repos'); search.issues = searchKind('issues'); search.prs = searchKind('prs');

// gh api: any REST path (or graphql). Reads run; anything else asks first. {owner}, {repo}, {branch} fill in.
async function api(env, argv) {
  const o = parseArgs(argv, ['X', 'method', 'f', 'raw-field', 'F', 'field', 'H', 'header', 'q', 'jq', 'input', 'hostname', 't', 'template', 'cache']);
  let endpoint = o._[0];
  if (!endpoint) return fail('usage: gh api <endpoint> [-X method] [-f key=value] [--jq expr]');
  const fill = (s) => String(s).replace(/\{owner\}/g, () => (env.repo ? env.repo.owner : '{owner}')).replace(/\{repo\}/g, () => (env.repo ? env.repo.name : '{repo}')).replace(/\{branch\}/g, () => env.branch || '{branch}');
  endpoint = fill(endpoint);
  const fields = {};
  const typed = (v) => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^-?\d+(\.\d+)?$/.test(v) ? +v : v);
  const put = (k, v) => {
    const m = /^(.+?)\[\]$/.exec(k);
    if (m) (fields[m[1]] = fields[m[1]] || []).push(v); else fields[k] = v;
  };
  for (const kv of [...(o.multi.f || []), ...(o.multi['raw-field'] || [])]) { const i = String(kv).indexOf('='); if (i > 0) put(kv.slice(0, i), fill(kv.slice(i + 1))); }
  for (const kv of [...(o.multi.F || []), ...(o.multi.field || [])]) {
    const i = String(kv).indexOf('=');
    if (i <= 0) continue;
    let v = kv.slice(i + 1);
    if (v.startsWith('@')) { v = v === '@-' ? env.stdin || '' : (env.readFile ? await env.readFile(v.slice(1)) : null); if (v == null) return fail(`could not read ${kv.slice(i + 2)}`); put(kv.slice(0, i), v); }
    else put(kv.slice(0, i), typed(fill(v)));
  }
  let body = Object.keys(fields).length ? fields : undefined;
  if (o.input) { const raw = o.input === '-' ? env.stdin || '' : env.readFile ? await env.readFile(o.input) : null; if (raw == null) return fail(`could not read ${o.input}`); body = JSON.parse(raw); }
  const graphql = /^\/?graphql$/.test(endpoint);
  const method = String(o.X || o.method || (body ? 'POST' : 'GET')).toUpperCase();
  let path = graphql ? '/graphql' : '/' + endpoint.replace(/^\/+/, '').replace(/^https:\/\/api\.github\.com\//, '');
  // The storage repo is never reachable, by name or by numeric id.
  const said = decodeURIComponent(`${path} ${JSON.stringify(body || {})}`).toLowerCase();
  if ((env.storageName && said.includes(env.storageName.toLowerCase())) || /^\/repositories\//.test(path)) return fail('gh: that would reach Squiggle\'s storage repo (or a repo by id), which isn\'t available to commands');
  if (method === 'GET' && body && !graphql) { path += (path.includes('?') ? '&' : '?') + new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])); body = undefined; }
  const read = method === 'GET' || (graphql && !/\bmutation\b/.test(String(body && body.query || '')));
  if (!read) await ask(env, { title: `${method} ${path} on GitHub`, details: body ? [JSON.stringify(body).slice(0, 300)] : [] });
  let data;
  if (o.paginate && method === 'GET' && !graphql) {
    data = [];
    for (let page = 1; page <= 10; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const chunk = await env.gh(`${path}${/[?&]per_page=/.test(path) ? '' : `${sep}per_page=100`}&page=${page}`);
      const items = Array.isArray(chunk) ? chunk : (chunk && Object.values(chunk).find(Array.isArray)) || [];
      data.push(...items);
      if (items.length < 100) break;
    }
  } else data = await env.gh(path, { method, body });
  if (graphql && data && data.errors) return fail(`gh: ${data.errors.map(e => e.message).join('; ')}`);
  if (data == null) return ok('');
  return jqOut(env, o, data);
}

async function auth(env, argv) {
  const [sub] = argv;
  if (sub === 'status' || !sub) {
    const me = await env.login();
    return { stdout: `github.com\n  ✓ Logged in to github.com account ${me} (Squiggle's GitHub App)\n  - Active account: true\n  - Git operations protocol: https\n`, stderr: '', exitCode: 0 };
  }
  if (sub === 'token') return fail('gh auth token: tokens are never shown to commands here');
  return fail(`gh auth ${sub}: Squiggle handles sign-in (Settings); nothing to do here`);
}

const GROUPS = { pr, issue, repo, run, workflow, release, search };
// Options that take a value, per subcommand: the same letter means different things (pr merge -r is --rebase,
// pr create -r is --reviewer; pr view -c is --comments, pr close -c is --comment).
const OUT = ['R', 'repo', 'json', 'q', 'jq'];
const BODY = ['b', 'body', 'F', 'body-file'];
const VERB_SPECS = {
  'pr list': [...OUT, 's', 'state', 'L', 'limit', 'B', 'base', 'H', 'head', 'A', 'author', 'l', 'label', 'a', 'assignee', 'S', 'search'],
  'pr create': [...OUT, 't', 'title', ...BODY, 'B', 'base', 'H', 'head', 'l', 'label', 'a', 'assignee', 'r', 'reviewer', 'm', 'milestone', 'T', 'template'],
  'pr edit': [...OUT, 't', 'title', ...BODY, 'B', 'base', 'add-label', 'remove-label', 'add-reviewer', 'remove-reviewer', 'add-assignee', 'remove-assignee', 'm', 'milestone'],
  'pr comment': [...OUT, ...BODY], 'pr review': [...OUT, ...BODY], 'pr close': [...OUT, 'c', 'comment'],
  'pr merge': [...OUT, 't', 'subject', ...BODY, 'match-head-commit'],
  'issue list': [...OUT, 's', 'state', 'L', 'limit', 'l', 'label', 'a', 'assignee', 'A', 'author', 'S', 'search', 'm', 'milestone', 'mention'],
  'issue create': [...OUT, 't', 'title', ...BODY, 'l', 'label', 'a', 'assignee', 'm', 'milestone'],
  'issue edit': [...OUT, 't', 'title', ...BODY, 'add-label', 'remove-label', 'add-assignee', 'remove-assignee', 'm', 'milestone'],
  'issue comment': [...OUT, ...BODY], 'issue close': [...OUT, 'c', 'comment', 'r', 'reason'],
};
const SPECS = { repo: ['R', 'repo', 'json', 'q', 'jq', 'L', 'limit', 'visibility'], run: ['R', 'repo', 'json', 'q', 'jq', 'L', 'limit', 'b', 'branch', 's', 'status', 'e', 'event', 'u', 'user', 'w', 'workflow', 'job'], workflow: ['R', 'repo', 'json', 'q', 'jq', 'L', 'limit'], release: ['R', 'repo', 'json', 'q', 'jq', 'L', 'limit'], search: ['json', 'q', 'jq', 'L', 'limit', 'repo', 'owner', 'state', 'language'] };
export const GH_COMMANDS = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, Object.keys(v)]));

export async function runGh(argv, env) {
  const [area, ...rest] = argv;
  try {
    if (!area || area === 'help' || area === '--help') return ok(env.help || 'usage: gh <command> <subcommand> [flags]');
    if (area === '--version' || area === 'version') return ok('gh version 2.62.0 (Squiggle)');
    if (area === 'api') return await api(env, rest);
    if (area === 'auth') return await auth(env, rest);
    if (area === 'browse') { const r = repoOf(env, parseArgs(rest, ['R', 'repo'])); return ok(`https://github.com/${r.full}`); }
    const group = GROUPS[area];
    if (!group) return fail(`unknown command "${area}" for "gh". Available here: ${[...Object.keys(GROUPS), 'api', 'auth', 'browse'].join(', ')}`);
    const [sub, ...args] = rest;
    const verb = { ls: 'list', new: 'create' }[sub] || sub;
    if (!verb || !group[verb]) return fail(`unknown command "${sub || ''}" for "gh ${area}". Available here: ${Object.keys(group).join(', ')}`);
    return await group[verb](env, parseArgs(args, VERB_SPECS[`${area} ${verb}`] || (area === 'pr' || area === 'issue' ? OUT : SPECS[area])));
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (e && e.status === 404) return fail(`GraphQL: Could not resolve to a resource (HTTP 404): ${msg}. Check the number or repo, and that Squiggle has access to it (Settings → Manage repo access).`);
    return fail(e instanceof GhError ? msg : `gh: ${msg}${e && e.status ? ` (HTTP ${e.status})` : ''}`);
  }
}
