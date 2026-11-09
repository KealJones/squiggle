# Setting up your own Squiggle

About 10 minutes. You end up with the app on GitHub Pages (or a Worker) and a tiny Cloudflare Worker relay, with your conversations in a private repo you own. To just try Squiggle first, open the app and pick "Try it without signing in" (the demo keeps everything in your browser; signing in later carries it over).

## Before you start

You need a GitHub account, a free Cloudflare account and Node 20+.

## 1. Create a GitHub App

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

## 2. Host it

Squiggle has two parts: the **app** (static files) and a small **relay** Worker on Cloudflare. Pick one setup.

### Option A: app on GitHub Pages, relay on Cloudflare (recommended)

**Deploy the relay** (once; again only if the relay code changes):

```bash
git clone https://github.com/<you>/squiggle && cd squiggle
npm install
```

Edit `wrangler.relay.toml`:

```toml
GITHUB_CLIENT_ID = "Iv23li…"                    # from step 1
GITHUB_APP_SLUG  = "squiggle-yourname"
ALLOWED_ORIGINS  = "https://<you>.github.io"     # or your Pages custom domain, e.g. https://example.com
```

```bash
npx wrangler login
npx wrangler deploy --config wrangler.relay.toml
```

Wrangler prints the relay's address, like `https://squiggle-relay.<you>.workers.dev`.

To redeploy the relay on every push instead, connect the repo in Cloudflare (Workers & Pages → `squiggle-relay` → Settings → Builds) with the deploy command `npx wrangler deploy --config wrangler.relay.toml`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets for the Deploy workflow. Use one or the other.

Optional, for more reliable web search: add a free [LangSearch](https://langsearch.com) API key as a secret (`npx wrangler secret put LANGSEARCH_API_SECRET_KEY --config wrangler.relay.toml`). Without it, search uses DuckDuckGo, then Wikipedia when DuckDuckGo asks for a bot check.

**Publish the app.** In your copy of this repo on GitHub:

1. **Settings → Secrets and variables → Actions → Variables:** add `SQUIGGLE_RELAY_URL` set to the relay's address.
2. Push to `main` (or run the **Deploy** workflow). It publishes the app to a `gh-pages` branch.
3. **Settings → Pages → Source: Deploy from a branch**, branch `gh-pages`, folder `/ (root)`. The app appears at `https://<you>.github.io/squiggle/`, or `https://<your-domain>/squiggle/` if your Pages site has a custom domain. Use that as the GitHub App's Homepage URL.

Every pull request from this repo also gets a **live preview** at `https://<you>.github.io/squiggle/pr-preview/pr-<number>/`, linked from a comment on the PR and removed when it closes (`.github/workflows/pr-preview.yml`). The preview is the app on the same origin as the deployed one, so it uses the same relay and the same sign-in and settings in your browser.

GitHub Pages on a private repo needs a paid plan; the code holds no secrets, so a public repo is fine (your data lives in your private storage repo).

To have pushes redeploy the relay too, add a Cloudflare API token (**Edit Cloudflare Workers** template) as the `CLOUDFLARE_API_TOKEN` secret, your account id as `CLOUDFLARE_ACCOUNT_ID`, and the variables `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG` and (for a custom domain) `SQUIGGLE_APP_ORIGINS`. See `.github/workflows/deploy.yml`.

### Option B: everything on one Cloudflare Worker

The Worker can serve the app too, so there's a single deploy and a single address. Edit `wrangler.toml` (client ID and slug as above), then:

```bash
npx wrangler login
npx wrangler deploy
```

The app is at the printed `https://squiggle.<you>.workers.dev`.

## 3. Open it

Open the app's address on your computer. Setup walks you through:

1. **Sign in with GitHub**: enter the code it shows on github.com.
2. **Install the app** on your account, choosing which repos the agent may use: the ones you want it to work on (you can change this later). The storage repo gets added automatically if Squiggle creates it; if you'll use an existing repo for storage, include that one too.
3. **Choose storage**: create a new private repo (default name `squiggle-state`) or pick an existing private one. If it already has other files, Squiggle keeps its data in a `squiggle/` folder.
4. **Download the model.**

On your phone: open the same URL, sign in, and Squiggle finds your storage repo automatically. Use "Add to Home Screen" to install it as an app.

## Which repos can the agent use?

The same GitHub App handles everything: your storage repo and every repo the agent clones, commits to, pushes to or opens pull requests on. Its access is the overlap of two things: repos **you** can access, and repos you've **installed the app on**.

- **Your repos:** pick them when installing the app. To add or remove repos later, use **Settings → Manage repo access** in Squiggle (or GitHub → Settings → Applications → Installed GitHub Apps → Configure).
- **Organization repos:** install the app on the organization too (needs "Any account" in step 1, plus an org owner's approval).
- **Anyone's public repos:** the agent can clone and read them without installing anything. It can't push to repos you don't have write access to.

## 4. (Optional) Protect `main` on GitHub

Optional backstop. In a repo where you never want direct pushes to `main` (even ones you approve in Squiggle): **Settings → Rules → Rulesets → New branch ruleset**, target the default branch, and enable **Require a pull request before merging**.

## What goes where

| Data | Where it lives |
|---|---|
| Model weights | Downloaded from Hugging Face once, stored in this browser |
| Voice models | Downloaded once, stored in this browser |
| Conversations, memory, `/home` files | Your private storage repo on GitHub, plus a local copy in this browser |
| Repo clones (`/repos`) | This browser only; share work by pushing branches |
| Settings (model, theme, context mode) | This browser only |
| GitHub sign-in | This browser only; passes through your Worker on the way to GitHub, never stored there |

Your Worker relays git traffic and (if `ENABLE_FETCH` is on) pages the agent reads. It runs on your own Cloudflare account and logs nothing. The model runtime loads from a version-pinned jsDelivr URL; the optional smart-context search model (23 MB) loads from Hugging Face. Attachments and voice also load version-pinned libraries from jsDelivr (Tesseract.js for OCR, pdf.js for PDFs, ONNX Runtime Web and a phonemizer for speech).


## Lab mode

Settings → Lab (or `?lab=1` in the address) lists the research and size-test models and the experimental
switches (no prompt, GPU and all cores for the CPU models, AI-managed context). [docs/lab.md](lab.md) says
what each one was for and how it did.
