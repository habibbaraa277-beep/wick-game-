# Wick and the Dark Station: hosting guide

This folder is the complete game. It works on any static host and installs on phones as an app.

## 1. Put the game online (about 5 minutes, free)

Pick one:

- **Netlify Drop**: go to app.netlify.com/drop and drag this whole folder (or the .zip) onto the page. You get a link immediately.
- **Cloudflare Pages**: Workers & Pages > Create > Pages > Upload assets > upload this folder.
- **GitHub Pages**: upload the folder contents to a repository, then Settings > Pages.

The link must start with **https://** (all three do this for you). Open it on your phone to test.

## 2. Install on iPhone, iPad and Android (no store needed)

Open your link, then:

- **iPhone / iPad (Safari)**: tap Share, then **Add to Home Screen**.
- **Android (Chrome)**: tap **Install app** on the title screen (or menu, then Install app / Add to Home screen).

The game then opens fullscreen with its own icon and works offline.

## 3. Turn on the global leaderboard (free, no coding)

The game already contains the leaderboard screen. It needs a small server to store scores.

1. Create a free Cloudflare account (cloudflare.com).
2. **Workers & Pages > D1 > Create database**, name it `wick-scores`. Open its **Console** tab, paste everything from `leaderboard/schema.sql`, press Run.
3. **Workers & Pages > Create > Worker**, name it `wick-leaderboard`, click Deploy, then **Edit code**, delete everything, paste all of `leaderboard/worker.js`, and Deploy.
4. In the Worker: **Settings > Bindings > Add > D1 database**. Variable name must be exactly `DB`. Choose `wick-scores`.
5. Still in Settings, **Variables and secrets**: add a secret named `ADMIN_TOKEN` (any long random text, keep it private). Optional: add `ALLOWED_ORIGIN` set to your game's link so only your site can post scores.
6. Copy the Worker address (looks like https://wick-leaderboard.YOURNAME.workers.dev).
7. Open `index.html` in a text editor. Near the top find `leaderboard: ""` and paste your address between the quotes. Save and upload the folder again.

Players opt in on the High scores screen. Their names and scores are then public.

**Removing a name** (for example an offensive one), with any tool that can send a request:

    POST https://YOUR-WORKER/admin/remove
    header  x-admin-token: YOUR_ADMIN_TOKEN
    body    {"name":"the name to remove"}

**How scores are protected:** every score arrives with the player's blocks. The server replays them with the same game engine and only accepts solutions that really reach the switch; the block count is measured by the server. Time, hints and retries are reported by the player's device, so a determined cheater could fake those. If a competition needs stricter rules, say so and the server can be changed to rank only fully verified values.

## 4. App Store and Google Play (optional)

Not needed for installing, but possible later:

- Go to **pwabuilder.com**, enter your game's link, and it produces an Android package and an iOS project from this same game.
- Google Play needs a developer account (one-time $25). Apple's App Store needs the Apple Developer Program ($99 per year) and a Mac with Xcode to finish the iOS build. Apple may also ask for more than a web page wrapper.
