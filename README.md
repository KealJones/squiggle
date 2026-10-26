<p align="center"><img src="app/icons/icon-192.png" width="72" alt=""></p>

<h1 align="center">Squiggle</h1>

<p align="center">A private AI agent that runs on your own device, and picks up where you left off on any other.</p>

Squiggle runs Google's Gemma 4 model on your GPU, right in the browser. Your
conversations, memory and the agent's files live in a **private GitHub repo you
own**, so you can start something on your desktop and continue on your phone.
The agent can also clone your repos, work on a branch, commit, push and open
pull requests.

There's no backend to run. The only server piece is a tiny Cloudflare Worker
(free tier) that serves the app and relays the few GitHub requests browsers
aren't allowed to make directly.

## What it does

- **On-device model**: Gemma 4 E2B (1.9 GB, fast, fine on phones) or E4B (2.8 GB, smarter). Downloads once per device, resumable, then works offline.
- **Sessions that follow you**: every conversation syncs through your storage repo. Two devices can chat offline in the same session; their messages merge on the next sync instead of conflicting.
- **Threads**: reply in a thread on any message. The thread knows the conversation up to that point, the main chat stays uncluttered, and a one-line outcome shows under the parent message.
- **Git workspace**: `/home` is the agent's own synced folder; `/repos/<name>` holds clones. Tools: clone, status, branch, commit, push, pull, log, open PR, list repos.
- **Memory**: a small graph of facts about you and your projects (`memory/facts.jsonl`), learned as you chat or added by hand, reviewable in the Memory panel.
- **Context for small models**: compaction by default (rolling summary + recent messages). Turn on **Smart context** in Settings to also retrieve the most relevant earlier messages, web pages and files for each question. "What the model saw" on any reply shows exactly what went in.
- **Search**: search all your chats from the sidebar; the agent can search them too (`search_history`).
- **Web and code**: `fetch_url` reads pages; `run_js` runs JavaScript in an isolated sandbox.

## How it keeps you safe

These are enforced in code, not just asked of the model:

- **Pushes outside the agent's own branches need your OK.** The agent pushes `agent/…` branches freely. Pushing any other branch (like `main`) shows a card in the chat with the commits and **Allow once / Always allow / Don't allow**. "Always allow" applies to that one branch in that one repo, syncs to your devices, and can be revoked in Settings. The decision only ever comes from your click.
- **Workflow changes always ask.** A push that changes `.github/workflows/` files asks every time, on any branch, even with "Always allow", because workflows run code with the repo's secrets.
- **Never a force-push.** History on GitHub is never rewritten.
- **The model never sees your GitHub token.** Model-written JavaScript runs in a sandboxed frame and worker with no access to the app's storage, token or sessions, and is killed if it runs too long.
- **Outside content is labelled as data.** Web pages, repo files and tool output reach the model wrapped in `<untrusted key="…">` tags with a per-session random key, plus a rule never to follow instructions inside them. This makes prompt injection much less likely but can't rule it out, which is why the limits above don't depend on the model behaving.
- **The storage repo must be private.** Setup refuses public repos.

## Set up (about 10 minutes)

You need a GitHub account, a free Cloudflare account and Node 20+.

### 1. Create a GitHub App

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** ([direct link](https://github.com/settings/apps/new)).

- **GitHub App name**: anything, e.g. `Squiggle (yourname)`. The URL-friendly version of it is the app's *slug*.
- **Homepage URL**: your future Worker URL (you can use `https://example.com` for now and fix it later).
- **Callback URL**: leave empty.
- **Enable Device Flow**: ✅ checked.
- **Expire user authorization tokens**: leave checked (Squiggle refreshes them).
- **Webhook → Active**: ❌ unchecked.
- **Repository permissions**:
  - Contents: **Read and write** (clone, commit, push)
  - Pull requests: **Read and write** (open PRs)
  - Actions: **Read and write** (start background jobs and read their results; used by scheduled jobs, coming soon)
  - Workflows: **Read and write** (write the job files in `.github/workflows/`; every push that changes a workflow file still asks you first)
  - Metadata: Read-only (set automatically)
- **Repository creation** (if your GitHub shows this permission): **Read and write**. It lets setup create your storage repo for you; without it, setup opens a pre-filled "new private repo" page instead.
- **Where can this GitHub App be installed?**
  - **Only on this account** if the agent will only work on your personal repos.
  - **Any account** if you also want it on repos in a GitHub organization. The app still isn't listed anywhere; only people with the link can install it, and an org owner has to approve installing it on the org.

Create it, then note the **Client ID** and the **slug** (from the app's URL, `github.com/apps/<slug>`).

### 2. Deploy the Worker

```bash
git clone https://github.com/KealJones/squiggle && cd squiggle
npm install
```

Edit `wrangler.toml`:

```toml
GITHUB_CLIENT_ID = "Iv23li…"        # from step 1
GITHUB_APP_SLUG  = "squiggle-yourname"
```

```bash
npx wrangler login
npx wrangler deploy
```

Wrangler prints your URL, like `https://squiggle.<you>.workers.dev`. Put it in the GitHub App's Homepage URL if you used a placeholder.

### 3. Open it

Open the URL on your computer. Setup walks you through:

1. **Sign in with GitHub**: enter the code it shows on github.com.
2. **Install the app** on your account, choosing which repos the agent may use: the ones you want it to work on (you can change this later). The storage repo gets added automatically if Squiggle creates it; if you'll use an existing repo for storage, include that one too.
3. **Choose storage**: create a new private repo (default name `squiggle-state`) or pick an existing private one. If it already has other files, Squiggle keeps its data in a `squiggle/` folder.
4. **Download the model.**

On your phone: open the same URL, sign in, and Squiggle finds your storage repo automatically. Use "Add to Home Screen" to install it as an app.

### Which repos can the agent use?

The same GitHub App handles everything: your storage repo and every repo the agent clones, commits to, pushes to or opens pull requests on. Its access is the overlap of two things: repos **you** can access, and repos you've **installed the app on**.

- **Your repos:** pick them when installing the app. To add or remove repos later, use **Settings → Manage repo access** in Squiggle (or GitHub → Settings → Applications → Installed GitHub Apps → Configure).
- **Organization repos:** install the app on the organization too (needs "Any account" in step 1, plus an org owner's approval).
- **Anyone's public repos:** the agent can clone and read them without installing anything. It can't push to repos you don't have write access to.

### 4. (Optional) Protect `main` on GitHub

Optional backstop. In a repo where you never want direct pushes to `main` (even ones you approve in Squiggle): **Settings → Rules → Rulesets → New branch ruleset**, target the default branch, and enable **Require a pull request before merging**.

## What goes where

| Data | Where it lives |
|---|---|
| Model weights | Downloaded from Hugging Face once, stored in this browser |
| Conversations, memory, `/home` files | Your private storage repo on GitHub, plus a local copy in this browser |
| Repo clones (`/repos`) | This browser only; share work by pushing branches |
| Settings (model, theme, smart context) | This browser only |
| GitHub sign-in | This browser only; passes through your Worker on the way to GitHub, never stored there |

Your Worker relays git traffic and (if `ENABLE_FETCH` is on) pages the agent reads. It runs on your own Cloudflare account and logs nothing. The model runtime loads from a version-pinned jsDelivr URL; the optional smart-context search model (23 MB) loads from Hugging Face.

## Development

```bash
npm test                    # unit tests (guards, sync merges, context, Worker)
node tests/e2e/run.mjs      # end to end in headless Chromium: two-device sync
                            # against a real git server, git tools, sandbox, a
                            # full agent turn with a scripted model
npm run dev                 # local Worker + app at http://localhost:8787
npm run vendor              # rebuild app/vendor/ after changing a library version
```

No build step: the app is plain ES modules in `app/`. See [CLAUDE.md](CLAUDE.md) for the architecture.

## Roadmap

- **Next**: voice call mode (speak, auto-send on pause, replies read aloud), file attachments and document search, skills and custom agents.
- **Then**: scheduled jobs via GitHub Actions in your storage repo, remote MCP servers, push notifications.
