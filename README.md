# zouzou's food lister

Rank every meal you eat. Add a photo, tap the one you prefer against past meals, get a score. Zouzou the cat judges you for it.
Plain HTML/CSS/JS, no build step. Data is stored in the browser (IndexedDB) on each device.

## Tabs

- **home**: your top meals, recent meals, rematch and "what to eat?".
- **my meals**: *eaten* (search + filter) and *want to try* (suggested meals you can add in one tap).
- **+ add**: photo first, then tap the photo you prefer against your past meals.
- **play**: *zouzou's run*, a dino-style runner. California (palm trees, cacti, surfboards, tacos, seagulls) until 600 points, then you cross into New Jersey.
- **zouzou**: about zouzou, badges, settings, ai setup, data.

## The route (play tab)

Zouzou starts in front of her house on Kingman Ave in Los Angeles, runs past Rustic Canyon Elementary, crosses into New Jersey at 600 points,
and passes the blue house on Kendal Ave. The houses are pixel art drawn from street photos (`house-ca.png`, `house-nj.png`, `school.png`).
**Privacy:** the street signs show house numbers (674 and 29). If you host this publicly and don't want that, set `SHOW_HOUSE_NUMBERS = false`
at the top of `game.js` and the game shows street names only.

## How scoring works

- Your score comes from where a meal lands in your ranking. It is spread evenly, then **shrunk toward the middle while you have few meals**
  (two meals can't tell a 10 from a 1), so scores firm up as you rank more: 2 meals span about 5.1-7.4, 10 meals 2.4-9.1, 50 meals 1.3-9.8.
- Misclicked? **Undo last pick** during the comparison.
- The **AI look score** is separate: it only rates how the photo *looks*. The model scores four parts (appetizing, presentation,
  freshness, lighting) against fixed anchors, and the app computes the final number from them (weights 40/25/20/15). Not food = 0.

## The cat's roasts

Every roast contains *gluttonous* or a synonym, enforced in code. A local generator reacts instantly when you post a photo; when the AI
finishes it writes one about the actual plate. Roasts only target appetite and eating habits (no slurs, no protected traits).

## AI setup

Zouzou tab -> ai rating setup. Two providers: **groq** (`qwen/qwen3.8-27b`) or **anthropic** (Opus 5.5 / Haiku 5.5).
Paste your own key; it is stored only in this browser, **never in the repo**. Do not hardcode a key in these files: the repo is public.
The official `@anthropic-ai/sdk` (v0.133.0) is vendored in `vendor/anthropic-sdk.mjs`, so the page loads no third-party code.

## Run locally

```bash
cd plated-web
python3 -m http.server 8000
# open http://localhost:8000
```

## Publish free on GitHub Pages

1. Create a **public** GitHub repo and upload the *contents* of this folder (not the folder itself), including `icons/` and `vendor/`.
2. Repo **Settings -> Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute your app is at `https://<username>.github.io/<repo>/`.

## Install on iPhone

1. Open the Pages URL in **Safari**.
2. **Share -> Add to Home Screen -> Add**. It opens full-screen and works offline.

## Updating

Edit files, upload them, and bump `CACHE` in `sw.js` (e.g. `zouzou-v10`) so installed copies refresh. Then remove and re-add the Home Screen app if it still looks old.

## Notes

- Data is per device and per browser. Deleting the Home Screen app or clearing Safari website data erases it.
- Internal storage names still say `plated` (database and settings keys) so existing data survives the rename.
