# Put NetSeer online for free

This puts a public copy of NetSeer on the internet at a free `https://netseer-….onrender.com` address that anyone can open. It updates itself every time the GitHub repo's `main` branch changes.

It uses [Render](https://render.com)'s free plan, set up by [`render.yaml`](../render.yaml) in this repo. NetSeer's own public copy, **[netseer.onrender.com](https://netseer.onrender.com)**, was deployed exactly this way.

## Before you start

**What the free plan gives you:**
- A real Python server, which NetSeer needs to read captures and build PDFs.
- A public HTTPS address on `onrender.com`.
- Automatic redeploys when you push to GitHub.
- 750 free instance hours a month, enough for one service running all month.

**The trade-offs:**
- **It sleeps.** After 15 minutes without visitors the server stops. The next visit wakes it, which takes about a minute, and then it's quick again.
- **Small server.** About 512 MB of memory, so this setup limits uploads to 20 MB per capture. The app says so on the drop zone and the welcome card, and offers a link to install NetSeer when a file is bigger. Installed copies have no size limit.
- **It's public.** Anyone with the address can use it.

**How NetSeer behaves when hosted** (`NETSEER_HOSTED=1`, already set in `render.yaml`):
- Captures people open are sent to the server, parsed in memory to draw the map, and not kept.
- Maps, names, and notes stay in each visitor's own browser (IndexedDB). Visitors never see each other's maps. See [How much you can store](../README.md#how-much-you-can-store) for the limits.
- Nobody can write files to the server. **Save to files and empty** (for Unwanted) downloads the JSON files to the visitor's computer instead.
- The app shows a short notice about this by the drop box in the sidebar and on the welcome screen.

Packet captures can contain sensitive information. Use a public copy for samples and demos. For real captures from your own network, run NetSeer on your own computer instead.

### Why Render, not Cloudflare or Vercel?

- **Cloudflare Pages** hosts static websites only. **Cloudflare Workers** run Python in a browser-style sandbox that can't run NetSeer's packet parser (scapy) or PDF builder (reportlab).
- **Vercel**'s free plan limits every request and response to 4.5 MB, so uploading captures, exporting diagrams, and downloading PDF reports fail for anything but tiny maps.
- **Render** runs NetSeer exactly as it runs on your computer, and redeploys from GitHub on its own.

## 1. Create a free Render account

1. Go to <https://dashboard.render.com/register>.
2. Choose **GitHub** to sign up. This links your GitHub account, so Render can see the NetSeer repo and get notified when it changes.
3. Follow the prompts to finish creating your account.

## 2. Deploy NetSeer

The quickest way is the button in the [README](../README.md#try-it-online), or this link:

<https://render.com/deploy?repo=https://github.com/Ardyn-Systems/Net_Seer>

Or from the Render dashboard:

1. Click **New** → **Blueprint**.
2. Connect GitHub if asked, and give Render access to the **Ardyn-Systems/Net_Seer** repository. You can grant access to just that repo.
3. Pick the repo. Render reads `render.yaml` and shows one web service called **netseer** on the **Free** plan.
4. Click **Deploy Blueprint** (or **Apply**).

The first build takes a few minutes: Render installs Python 3.12 and NetSeer's dependencies, then starts the server. Watch progress under the service's **Events** and **Logs**.

## 3. Open your public address

When the deploy shows **Live**, the address is at the top of the service page, for example `https://netseer-a1b2.onrender.com`. Open it to see NetSeer with the campus sample, then share it with anyone.

Render bases the address on the service name, with a few random characters added if the name is taken. For a different address, change the name under **Settings** before sharing. You can also add your own domain under **Settings** → **Custom Domains**.

## 4. Updates happen on their own

`render.yaml` sets `autoDeployTrigger: commit`. Every push or merge to `main` on GitHub makes Render rebuild and redeploy within a few minutes, and the public copy then runs the newest code. Nothing else needs to be running.

**Auto-deploy needs Render's GitHub App on the repo.** The Deploy button can build a public repo without it, so the first deploy works, but then GitHub has no way to tell Render about new commits. To check:

1. In Render, open your account **Settings** → **Git Deployment Credentials** and expand your GitHub account.
2. If it says **No repositories found**, open <https://github.com/apps/render/installations/new>.
3. Choose **Only select repositories**, pick **NetSeer**, and click **Install**.
4. After that, the next push to `main` deploys by itself. To pick up commits made before you installed it, choose **Manual Deploy** → **Deploy latest commit** on the service page.

Each deploy is listed under **Events**. If one goes wrong, the previous version keeps running. To go back to an older version, choose **Rollback** on an earlier deploy.

## Change the settings

In the service's **Environment** tab:

| Setting | Default here | Meaning |
| --- | --- | --- |
| `NETSEER_HOSTED` | `1` | Public mode: no writing to the server's disk |
| `NETSEER_MAX_UPLOAD_MB` | `20` | Largest capture accepted, in MB (a hosted copy defaults to 20; `0` means no limit) |

Saving a change redeploys the service.

## Take it offline

In the service's **Settings**: **Suspend Service** pauses it and keeps the address, while **Delete Web Service** removes it. Either way, nothing on GitHub changes.

## Other free options

- **Your own computer, shared:** run `netseer` locally and use a tunnel such as Cloudflare Tunnel (free) for a public address. It's only online while your computer is.
- **Hugging Face Spaces:** free Docker hosting with more memory. It doesn't redeploy from GitHub by itself; you'd need a GitHub Action to push changes there.
