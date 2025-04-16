# CHANGELOG / TODO

IMPROVED DATA FOR POPULAR REPOS:

- ✅ Make https://tree.forgithub.com work
- ✅ Get the tree as well
- ✅ Get README for each as well
- ✅ BUG: ensure data refreshes, doesn't seem to now (underlying API doesn't reset).
- ✅ Made a new version that uses Schedule, Queue, KV, DO.
- ✅ Remove the DO and reset by giving it a new name
- ✅ See if I can hook this up DORM as a package for easy usage and find a way to neatly link it
- ✅ Ensure 500 get put in the DB but the result stays under 100mb (50kb max per row)
- ✅ Should probably only include URL to tree/readme and perhaps other LLM generated stuff, and should queue to prerender/cache these.
- 🟠 If it works... launch this! SUPER WORTHY. opensource on open data. Then, make plugins work for uithub interface.
- Enrichment: add owner data too (including twitter handle)

LLM STUFF

- Now make https://analysis.forgithub.com work in a similar way
  - trigger after popular latest is updated.
  - questions: Based on name, description, simple tree, and README, generate `{title,prompt}[]` that make sense from SEO perspective.
  - categories
  - summary
- Also make `shippers.forgithub.com` which would fetch people who ship most on any given day. post it here: https://x.com/jacksbridger/status/1890496111388840261
- Make questions.forgithub.com (generate questions JSON based on repo details + README) and ensure it does this every hour.

IMPROVED SITEMAPS

- Generate sitemap for https://chat.forgithub.com and ensure each page is super SEO friendly
- Generate sitemap for https://forgithub.com
- Generate sitemap for https://uithub.com

IMPROVE CHAT

- Use this data in the landing of https://chat.forgithub.com (overlaying questions, clickable)
- Make OG Image with the title and repo!
- Design

🔥 I think this would really make https://chat.forgithub.com something interesting: great longtail SEO! I don't have such good ones yet, so let's try this out!

FOR STUDENTS:

- Generate summary, categories, etc on rolling basis
- Change the definition so it actually generates a html page for every language in the result. where the html page is fully rendered, SEO friendly, and stored in KV

BONUS

fix activity parse w/ low enough CPU with a simpler good enough MVP base algo

# SPEC

Context:

- https://activity.forgithub.com/openapi.json
- https://ziptree.uithub.com/openapi.json

This is a Cloudflare worker that uses this that, every night at 3am:

- gets the repos dataset of the previous day
- sorts on activity, gets top 500 and adds them to a queue via sendBatch
- adds one more item to queue after all that: aggregate

The queue handler (export default { queue}) with max concurrency of 1 and max batch size of 100:

- retrieve repo details using GitHub API
- retrieve README.md from raw.githubusercontent.com
- get `token-tree` from ziptree.uithub.com (use env.ZIPTREE_SECRET)
- stores all of it in a DORM SQL table `repositories`. The table contains details_json, readme, tree, popular_date (YYYY-MM-DD)

The aggregate task in the queue (at the end) fetches all popular_date of todays date, and puts the result in a KV under `latest`.

The worker itself, then, outputs the content of KV latest at `/index.json`, a markdownified version at `/index.md`, and a landingpage viewing them at `/index.html`. Based on the accept header, the right one is chosen if `index.ext` wasn't specified.

Besides this, the worker exposes /trigger and /aggregate that, given the right admin secret, will perform these actions that are normally handled by the schedule and queue.

# Getting started

- You can clone this repo and easily host on Cloudflare yourself
- You can then run `/trigger` to start indexing. Change the 500 into a lower number to be done faster (for testing purposes )
- `/aggregate` allows intermediately aggregating into the KV
- To explore the data in the DORM: https://studio.outerbase.com/local/new-base/starbase and fill https://popular.forgithub.com/admin
