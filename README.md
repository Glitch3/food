# Plated (web)

Rank every meal you eat. Add a photo, tap the one you prefer against past meals, get a score.
Plain HTML/CSS/JS, no build step. Data is stored in the browser (IndexedDB) on each device.

## The fun bits

- **Pixel cat** in the top right (`cat.png`, drawn on a 32×32 grid). It insults you when you open the app and whenever you rate a meal. Tap it to pet it: pixel hearts, a meow, and a pet counter.
  It also reacts while you rank and shrinks when you scroll so it never covers your meals.
- **Confetti + count-up score** after every ranking, with a verdict ("Absolute banger" … "Yikes").
- **Rematch** (Home): two neighbouring meals go head to head; if the lower one wins, they swap.
- **What to eat?** (Home): slot-machine picker over your Want to Try list (or your top 5 meals).
- **Badges** (Profile): 9 unlockable badges. Sounds can be turned off in Profile → Settings.

## Want to try suggestions

Open the *want to try* tab: tap a suggested meal to add it in one tap, or press **save a meal** and start typing. Ideas
(breakfast, lunch, dinner, snacks, desserts, drinks) autofill the name and a note, and your own past meals show up first.
The idea list is `MEAL_IDEAS` in `app.js` if you want to add your own.

## Dates and AI rating

- Every meal has an **Eaten** date and time (set when you add it, editable later) and an automatic **Added to Plated** timestamp.
  The Home and My Meals lists show the eaten time. My Meals can be sorted by *My ranking*, *AI look* or *Newest*.
- **AI look-rating**: Claude looks at the photo and scores how good the meal *looks* (0-10) with a short comment, and names the
  dish if you left the name blank. It is separate from your own ranking, which is still decided by your taps.
  - Profile → AI look-rating: paste your own Anthropic API key and pick a model (Opus 5.5 or the cheaper Haiku 5.5).
  - The key is stored only in this browser (localStorage). Photos go to Anthropic only when a meal is analyzed. Use a key with a low spend limit.
  - The official `@anthropic-ai/sdk` (v0.133.0) is vendored in `vendor/anthropic-sdk.mjs`, so the page loads no third-party code at runtime.
    To upgrade it, see the comment at the top of that file.

## Run locally

```bash
cd plated-web
python3 -m http.server 8000
# open http://localhost:8000
```

## Publish free on GitHub Pages

1. Create a GitHub repo and push the contents of this folder to it.
2. Repo **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute your app is at `https://<username>.github.io/<repo>/`.

Use a **private** repo if you don't want the code public. Note GitHub Pages on a private repo
needs a paid plan; a public repo is free. Your meals are never in the repo either way, they
only live on your phone.

## Install on iPhone

1. Open the Pages URL in **Safari** (must be Safari).
2. Tap **Share → Add to Home Screen → Add**.
3. Open Plated from the Home Screen. It runs full-screen and works offline.

## Updating

Edit files, push, and bump `CACHE` in `sw.js` (e.g. `plated-v5`) so installed copies refresh.

## Notes

- Data is per device and per browser. Deleting the Home Screen app or clearing Safari website
  data erases it. Nothing syncs between devices.
- Opening the app from the Home Screen (rather than a Safari tab) keeps iOS from clearing its
  storage after a week of inactivity.
