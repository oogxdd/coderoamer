# SEO Research Methodology — How to Actually Do This Properly

Date: 2026-08-08

Companion to `seo-positioning-research.md` (the findings so far, which are qualitative only) and `landing-page-copy.md` / the `website/` app (the pages built from those findings). This doc is the step-by-step process for turning that qualitative pass into real, validated SEO — written because no paid keyword tools or Search Console were available yet (site wasn't deployed).

## Phase 0 — Free validation (do this first, before spending anything)

1. **Google Trends** (trends.google.com) — enter the 10-15 candidate phrases from `seo-positioning-research.md`. Look at the relative trend line (growing / flat / declining over the last 12 months) and the **related queries / related topics** panel — this often surfaces phrasing nobody thought of. Needs a human in the Trends UI; not something scriptable via search.
2. **Google autocomplete + "People also ask"** — type each candidate phrase into Google by hand, note the autocomplete suggestions and the "People also ask" box. Free, ~20 minutes, surfaces real phrasing instead of marketing language.
3. **Manual read of Reddit/HN threads** — r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding, Hacker News. Search the candidate phrases, read how people describe the pain in their own words. (A first pass of this was already done via web search for this project — see the "demand signals" section of `seo-positioning-research.md` — but a founder's own read of the threads catches nuance an automated pass misses.)

If phrases still look alive after this pass, move to Phase 1.

## Phase 1 — Real numbers (this costs money)

Ahrefs Lite ($29/mo, no long-term commitment needed) — cheaper than the $129/mo Standard/API tier and sufficient for manual lookups:

1. **Keywords Explorer** — enter each candidate phrase, record:
   - **Volume** (searches/month)
   - **KD (Keyword Difficulty)** — lower is better for a new domain with no backlink history
   - **Traffic potential** — how much traffic the #1 page for the whole cluster gets, not just this one phrase
2. **Parent Topic** — Ahrefs will often say a phrase is really part of a broader topic. Use this to group pages instead of creating near-duplicate ones.
3. **Competitor organic keywords** — plug Hoplite.sh, herdr.dev, onorca.dev, getmoshi.app into Site Explorer → Organic Keywords. This shows which phrases are *already proven* to bring them traffic — the highest-value shortcut, since a competitor has already validated the demand.
4. Filter the combined list to: Volume > 50-100/mo, KD < 20-30 (appropriate for a brand-new domain with no link equity). This is the real shortlist.

## Phase 2 — Search intent → page structure

For each shortlisted phrase, search it manually in Google (incognito) and look at what's actually in the top 10:

- **Guides/blog posts dominate** → the phrase wants content/a blog post, not a product landing page
- **Competitor products dominate** → a landing page can compete directly
- **Reddit/forum threads dominate** → real demand, weak content competition — good opening for a strong SEO landing page

This determines what *kind* of page a phrase deserves — it's the logic behind why the site has separate pages for different phrases (`/`, `/phone`, `/persistent`, `/compare`) instead of one page trying to rank for everything.

## Phase 3 — Technical foundation (one-time setup)

- Deploy to a permanent domain — blocks everything else (Search Console needs a verified live domain)
- Connect **Google Search Console** immediately after deploying (free) — becomes the primary source of truth post-launch
- Add `sitemap.xml`, `robots.txt`, an OG image (not yet done — see gaps in `session-handoff-seo-landing.md`)
- Structured data (already in place: `SoftwareApplication` on the homepage variants, `FAQPage` on FAQ sections)

## Phase 4 — Post-launch loop

1. 2-4 weeks after the domain is indexed: Search Console → Performance → sort by impressions.
2. Look for phrases with **high impressions but low CTR/position** — Google already thinks the page is relevant, but the title/meta/H1 is underselling it. Rewrite those specifically.
3. Look for phrases getting impressions that **weren't targeted at all** — organic discoveries that Trends/Ahrefs didn't predict; often the most valuable signal because they're unprompted.

## Budget summary

| Step | Cost | When |
|---|---|---|
| Trends + autocomplete + Reddit/HN read | $0 | Now, before spending anything |
| Ahrefs Lite, one month, manual lookups | $29 one-time | Once Phase 0 phrases look alive |
| Google Search Console | $0 | Immediately after domain deploy |
| Ahrefs API tier ($129/mo) | Not needed | Skip — manual UI lookups on Lite cover this use case |

## Open question for the founder

Whether to run Ahrefs Lite now (needs the founder's card + login) or wait until the domain is live so Search Console data can run in parallel. Either order works; running Ahrefs first de-risks the content plan before more pages get built, while waiting until domain launch means one less manual step before Search Console data starts accumulating.
