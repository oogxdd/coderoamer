# Session Handoff — CodeRoamer SEO / Positioning / Landing Site

Date: 2026-08-08

## What was requested

1. Review what phrases/keywords to use on the CodeRoamer site for SEO. Founder's mental model of the market: four user segments —
   1. Home-server owners who'd SSH in from a phone (not a direct fit yet, planned later)
   2. Owners of an always-on work machine using Claude Code Remote / Codex Remote / competitors (Orca, Happy, Omnara) to control an agent on that machine
   3. Herdr / Moshi-style terminal-multiplexer users (same idea — agent runs on a box you already have)
   4. People with **no home server**, who don't want to leave a computer on, and just want to spawn a sandbox somewhere — CodeRoamer's actual target, currently backed by Fly.io, with an emphasis on **persistent** (not ephemeral) sandboxes
   Founder wanted to know if this positioning maps to real search demand, and asked about Ahrefs/API access and minimum spend to find out.
2. Once positioning was drafted: wrap the research into a markdown doc.
3. Write landing-page copy (structure + meta + text only, no design) based on that positioning.
4. Turn that copy into an actual Next.js site with a few page variations and subpages.
5. (This round) Write a handoff doc of the session, and deploy the site(s) — Vercel preferred, otherwise host on this Sprite.

## What was done

### Research (no paid tools available)
No Ahrefs API / Google Keyword Planner / Search Console access was available (site wasn't deployed, no budget approved yet). Instead did qualitative research via web search: looked at what competitors exist and what phrases publishers already write SEO content for, on the theory that published content targeting a phrase is a proxy for real search demand.

Competitors surveyed: Herdr, Orca (onorca.dev), Moshi (getmoshi.app), Omnara/Happy, ServerCC, Claudette Echo, CodeAgents Mobile, Hoplite.sh (YC S26), Depot, Cloudflare Sandbox SDK, E2B, Qovery, Northflank, Bunnyshell, Fly.io Sprites.

**Core finding:** a whole cluster of mobile apps (ServerCC, Claudette Echo, CodeAgents Mobile, Moshi, Happy/Omnara) are all *remote-control clients* — they assume you already have Claude Code/Codex running somewhere and just give you a phone UI to it. None of them provision the compute itself. Hoplite.sh is the closest real competitor (cloud sandbox that runs the agent for you) but is positioned as a team automation tool triggered from Slack/Linear/Sentry, not a personal chat-first mobile product.

**Conclusion:** the niche "chat-first interface + instant, persistent, no-server-needed cloud sandbox, for an individual developer, from a phone" is open.

Full writeup: `docs/seo-positioning-research.md` — includes the competitor table, demand signals (phrases with existing published content), recommended keyword targets, and honest caveats about what wasn't verified quantitatively.

### Landing copy
`docs/landing-page-copy.md` — three full copy variants (homepage + two SEO-supporting angles), each with meta title/description, H1/H2/body copy, FAQ blocks, and a notes section flagging which product claims need founder confirmation before publishing (multi-agent support, "more providers planned," idle-billing behavior, whether a stateless/ephemeral mode exists).

### Next.js site
Built at `website/` (separate Next.js 16 app, own package.json/lockfile, doesn't touch the Expo app). App Router, TypeScript, Tailwind v4, dark theme with a single emerald accent, no external assets, fully static build.

Pages:
- `/` — primary homepage, "no laptop" framing. Hero, problem/solution, persona grid, how-it-works, FAQ, `SoftwareApplication` JSON-LD.
- `/phone` — "from your phone, no SSH" landing variant, DIY-vs-CodeRoamer comparison block.
- `/persistent` — "persistent vs ephemeral sandboxes" landing variant.
- `/compare` — comparison table: CodeRoamer vs. remote-control apps vs. DIY SSH/Tailscale vs. team task-runner platforms.
- `/faq` — combined FAQ hub, `FAQPage` JSON-LD.
- `/start` — email-capture page the CTAs point to. **Client-side only, no backend** — doesn't actually send anywhere yet.

Verified: `npx next build` passes clean (all 7 routes static), all routes curl to 200 in dev.

VM checkpoints taken along the way: v74 (after research docs), v75 (after site build).

## Known gaps / things flagged, not yet resolved

- `/start` form has no backend — needs an actual email capture (e.g. a simple API route + storage, or a third-party form service) before this is a real CTA.
- Several product claims in the copy (multi-provider support beyond Fly.io, "more agents planned," idle-billing behavior, existence of a stateless/ephemeral mode) were written from the founder's description of the product, not verified against shipped behavior. Should be checked before publishing.
- No real keyword-volume data (no Ahrefs/Keyword Planner/GSC). Positioning is grounded in competitive analysis + proxy demand signals, not hard numbers.
- No custom domain/DNS decision made yet.
- No analytics (Plausible/GA/Vercel Analytics) wired in.
- No sitemap.xml / robots.txt generated yet.
- No OG image (social share preview will use default/blank).

## Potential further directions

1. **Validate cheaply once live**: verify the deployed domain in Google Search Console (free) and revisit `seo-positioning-research.md` in a few weeks with real impression/query data. Optionally rent Ahrefs Lite ($29/mo) for a month to manually check volume on the ~10 shortlisted phrases — cheaper than the $129/mo API tier.
2. **A/B the three homepage angles**: `/`, `/phone`, `/persistent` are three real, complete pages — could split traffic between them (or just watch which one earns more organic clicks/conversions once indexed) instead of picking one blind.
3. **Wire up `/start`**: minimal version could be a Vercel-hosted API route writing to a spreadsheet/Airtable/Resend audience, or swap in a third-party waitlist widget.
4. **Add sitemap.xml, robots.txt, and an OG image** before relying on organic search — cheap wins for crawlability and social sharing.
5. **Expand `/compare`** into individual comparison pages (`/vs/hoplite`, `/vs/ssh-tailscale`) if any single competitor comparison starts getting traction — more specific long-tail pages tend to rank easier than one general comparison table.
6. **Segment 1 (home-server SSH users)** was explicitly deprioritized by the founder as "not a direct fit yet" — worth a dedicated page only once that capability actually ships.
7. **Analytics**: add Vercel Analytics or Plausible before driving any traffic, so the A/B question in #2 is actually answerable.
