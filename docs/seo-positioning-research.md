# SEO / Positioning Research — CodeRoamer

Date: 2026-08-08
Status: qualitative research, no paid keyword-volume tools used (no Ahrefs API / Google Keyword Planner / Search Console access — site not deployed yet). Findings are inferred from what competitors and publishers already rank for, treated as a proxy for real demand ("if someone wrote SEO content targeting this phrase, someone is searching it").

## Product framing (as described by founder)

Four user segments for AI coding agents run remotely:

1. **Home server owners** — SSH in from phone, run agent in a terminal emulator. Not a direct fit for CodeRoamer today (planned future support). Advantage CodeRoamer has: chat-first interface vs. raw terminal.
2. **Rarely-off work machine owners** — use Claude Code Remote / Codex Remote or similar (Orca, Happy, Omnara) to control an agent running on their own always-on machine. These tools don't provide sophisticated sandboxing.
3. **Herdr / Moshi adepts** — terminal multiplexer / mobile terminal users, again running agents on their own box, no spawned sandboxes.
4. **No home server, don't want to leave a computer on** — want to spawn a sandbox somewhere and just go. CodeRoamer's actual differentiated target: one-tap spawn of a cloud sandbox (currently Fly.io, more providers later), with a focus on **persistent** sandboxes (state survives shutdown) rather than ephemeral ones.

## Competitive landscape

| Product | What it actually is | Does it provision compute for you? | Interface |
|---|---|---|---|
| Herdr (herdr.dev) | Rust terminal multiplexer for coding agents ("tmux for agents") | No — runs on a box you already have | Terminal |
| Orca (onorca.dev) | Desktop "Agent Development Environment", runs multiple agents, remote via SSH/self-hosted server/VM | No — you bring the remote box | Desktop app + mobile monitor |
| Moshi (getmoshi.app) | Mobile SSH/mosh terminal with push notifications, voice input | No — pure terminal client to your own server | Mobile |
| Omnara / Happy (happy.engineering, omnara.com) | Mobile/web command center for agents, voice-first, background process streaming | Partially — can run agent as background process, but not full sandbox provisioning | Mobile/web, chat-like |
| ServerCC, Claudette Echo, CodeAgents Mobile | Mobile apps for remote Claude Code control | No — assume Claude Code already running somewhere | Mobile |
| Hoplite.sh (YC S26) | Cloud sandbox that clones your repo and runs autonomous coding tasks | **Yes** — closest direct competitor | Triggered from Slack/Linear/Sentry/iMessage — task-queue for teams, not a personal chat app |
| Depot, Cloudflare Sandbox SDK, E2B, Qovery, Northflank, Bunnyshell | Sandbox/infra APIs for AI-generated code execution | Yes, but as infrastructure for developers building their own product on top | Devops/API, not consumer-facing |
| Fly.io Sprites | The underlying persistent-VM infrastructure (CodeRoamer's likely backend) | N/A — infra layer | N/A |

### Key gap found

There is a whole cluster of mobile apps (ServerCC, Claudette Echo, CodeAgents Mobile, Moshi, Happy/Omnara) that are all **remote-control clients** — they assume you already have Claude Code/Codex running on a machine somewhere and just give you a phone UI to it.

**None of them provision the compute itself.** Nobody says "no server? no laptop? we'll spin up a persistent sandbox for you in seconds, right from the chat."

Hoplite.sh is the closest real competitor to "cloud sandbox that runs the agent for you," but it's positioned as an autonomous task-runner for teams (triggered via Slack/Linear/Sentry), not as a personal chat-first mobile experience.

**This is CodeRoamer's open niche: chat-first interface + instant, persistent, no-server-needed cloud sandbox, for an individual developer, accessible from a phone.**

## Demand signals found (proxy: existing SEO content targeting the phrase)

Confirmed someone is searching for these (publishers wrote dedicated content):
- "keep claude code running 24/7" — mindstudio.ai
- "running claude code without a laptop" — levelup.gitconnected
- "run claude code in the cloud" — duet.so, jurniti.com
- "claude code on my phone with termux and tailscale" — dev.to/skeptrune (DIY audience, technical)
- "claude code sandbox" — Qovery, Northflank (devops framing, not consumer)

Pattern: demand exists, but the content is either a DIY recipe (stitch together tailscale+termux+tmux yourself) or an infra pitch aimed at teams/devops (pricing implies $100+/mo, API-first). Nobody owns the phrase with a simple consumer product.

## Recommended positioning statement

> Chat-first AI coding agent that spins up its own persistent cloud sandbox — no home server, no laptop left on.

## Priority keyword/phrase targets

1. `claude code without a laptop` / `codex without a laptop` — proven demand, weak product-level competition
2. `run coding agent from phone without ssh` — near-empty, exact match for segment 4
3. `persistent sandbox for ai coding agents` (contrast against "ephemeral sandbox") — reuse the persistent-vs-ephemeral narrative already established by Fly.io/HN discourse around Sprites
4. `ai coding agent cloud sandbox no server needed`
5. `keep coding agent running 24/7 without your computer`

Secondary / long-tail:
- "spawn cloud coding agent"
- "instant coding agent sandbox"
- "coding agent without home server"
- "claude code mobile no server"

## Caveats

- This is qualitative, not quantitative — no actual search volume numbers.
- No access to Google Trends absolute numbers, Ahrefs, Keyword Planner, or Search Console (site isn't deployed/indexed yet).
- Cheapest path to real numbers: Ahrefs Lite ($29/mo, manual UI lookup of ~10-20 phrases, no need for the $129/mo API tier) — or deploy a landing page targeting 2-3 phrases and watch organic impressions in Search Console over a few weeks (free, slower).
- Google Keyword Planner is free but only returns precise volume ranges once a Google Ads account has run some spend (rough rule of thumb ~$10-20); without spend it only shows broad buckets (10-100, 100-1K, etc).

## Next steps

- [ ] Landing page copy targeting priority phrases (see `landing-page-copy.md`)
- [ ] Deploy + verify in Search Console once live, revisit this doc with real query data
- [ ] Optionally validate cheaply via Ahrefs Lite manual lookups
