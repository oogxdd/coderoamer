# Landing Page Copy — CodeRoamer

Textual content + structure + meta only, no design/layout decisions. Three variants targeting the three strongest phrases from `seo-positioning-research.md`. Pick one as primary `/` and consider the others as supporting SEO landing pages (`/no-laptop`, `/from-phone`, etc.) once the site is live.

---

## Variant A — Primary / homepage

Target phrase: "claude code without a laptop" / "coding agent cloud sandbox no server needed"

### Meta
- **Title tag:** CodeRoamer — Run Claude Code and Codex From Your Phone, No Laptop Needed
- **Meta description:** CodeRoamer spins up a persistent cloud sandbox and drops you into a chat with your coding agent. No home server, no laptop left on, no SSH setup.
- **OG title:** Your coding agent, without the laptop
- **OG description:** One tap spawns a real cloud sandbox. Chat with Claude Code or Codex from your phone — nothing to leave running at home.
- **URL slug:** `/`

### H1
Your coding agent, without the laptop.

### Subheadline
CodeRoamer spawns a persistent cloud sandbox and puts you straight into a chat with it. No home server, no SSH, nothing to keep powered on.

### Hero CTA
Start a session → (button)
Secondary link: See how it works

### Section: The problem
**H2: You shouldn't need a home server to run a coding agent.**

Body:
Most ways to use Claude Code or Codex remotely assume you already have a machine somewhere — a laptop you leave open, a home server you SSH into, a VPS you provisioned yourself. If you don't have one of those, or don't want to leave it running, your options run out fast.

### Section: The solution
**H2: Spin up a sandbox, not a server.**

Body:
CodeRoamer gives you a chat. Behind it, one tap spins up a real, isolated cloud sandbox — not a shared container, not a toy REPL. Your agent runs there, with a full filesystem and shell, for as long as you need it.

### Section: Persistent, not ephemeral
**H2: Close the app. Come back later. Nothing's lost.**

Body:
Sandboxes from CodeRoamer are persistent — when you're done, the sandbox pauses instead of disappearing. Come back tomorrow and your agent picks up exactly where it left off: same files, same shell history, same running processes. No re-cloning the repo, no reinstalling dependencies.

### Section: Who it's for
**H2: Built for developers without a machine to spare.**

Three columns:
1. **No home server** — You don't run a NAS or a home lab. You still want a real sandbox, not just a chat window.
2. **Don't want to leave a laptop on** — Your laptop sleeps, travels, or gets closed. Your agent shouldn't stop because of it.
3. **On your phone, for real work** — Not just monitoring an agent running elsewhere — actually running it, from a phone, with nothing at home to keep alive.

### Section: How it works
**H2: From chat message to running sandbox in seconds.**

1. Open CodeRoamer and start a chat.
2. Tell it what you want to work on — it spawns a cloud sandbox behind the scenes.
3. Your agent (Claude Code, Codex, or others) runs inside it with full shell + filesystem access.
4. Close the app any time. The sandbox persists — reopen and keep going.

### FAQ (also useful as FAQPage schema)

**Do I need my own server?**
No. CodeRoamer provisions the sandbox for you on demand.

**What happens when I close the app?**
Your sandbox is persistent — it pauses rather than disappearing. Your files, running processes, and shell state are there when you come back.

**Which agents does it support?**
Claude Code and Codex today, with more planned.

**Where do sandboxes run?**
On Fly.io today, with more providers planned.

**Is this the same as Claude Code Remote Control or Codex Remote?**
No — those let you control an agent that's already running on a machine you own. CodeRoamer provisions the machine (sandbox) too, so you don't need one.

### Footer CTA
No laptop. No server. Just a chat and a sandbox. → Start a session

---

## Variant B — Supporting page: "from your phone"

Target phrase: "run coding agent from phone without ssh"

### Meta
- **Title tag:** Run a Coding Agent From Your Phone — No SSH, No Setup | CodeRoamer
- **Meta description:** Skip Termux, Tailscale, and SSH keys. CodeRoamer lets you run Claude Code or Codex from your phone by spawning a cloud sandbox — just open a chat.
- **URL slug:** `/from-phone`

### H1
Run a real coding agent from your phone. No SSH required.

### Subheadline
Forget Termux, Tailscale tunnels, and SSH keys. Open CodeRoamer, send a message, and your agent is running in its own cloud sandbox.

### Section: The old way vs. the CodeRoamer way

Two-column comparison:

**The DIY way**
- Set up Tailscale between your phone and a machine
- Install Termux, configure a terminal
- SSH in, start tmux so sessions survive disconnects
- Keep that machine powered on and reachable

**The CodeRoamer way**
- Open the app
- Start a chat
- Your agent is already running in its own sandbox

### Section: Why chat beats terminal-over-SSH on mobile
Body:
A terminal is a keyboard-and-cursor interface designed for a desk. On a phone, typing shell commands over a shaky connection is the worst part of remote coding. CodeRoamer's primary interface is chat — the same interaction model your phone is actually good at — with the terminal available only when you need to drop into it.

### FAQ

**Is this a terminal emulator?**
No. Chat is the primary interface; a terminal is available as a secondary tool when you need it.

**Do I need to configure networking, VPNs, or tunnels?**
No. There's no machine of yours to reach — CodeRoamer's sandbox is already reachable through the app.

**What if I lose connection mid-task?**
The sandbox keeps running. Reopen the app and reconnect to the same session.

---

## Variant C — Supporting page: persistent vs ephemeral

Target phrase: "persistent sandbox for ai coding agents"

### Meta
- **Title tag:** Persistent Cloud Sandboxes for AI Coding Agents | CodeRoamer
- **Meta description:** Most agent sandboxes are ephemeral — rebuilt from scratch every session. CodeRoamer's sandboxes persist, so your agent picks up exactly where it left off.
- **URL slug:** `/persistent-sandboxes`

### H1
Most agent sandboxes forget everything. Ours don't.

### Subheadline
Ephemeral sandboxes rebuild your environment from zero every time. CodeRoamer's sandboxes are persistent — your agent's filesystem, dependencies, and shell state survive between sessions.

### Section: Ephemeral vs persistent
**H2: Why "ephemeral" is the wrong default for real work.**

Body:
A lot of agent sandbox infrastructure treats every session as disposable: clone the repo, install dependencies, run the task, throw the environment away. That's fine for a single isolated task. It's wasteful and slow if you're actually working on something over multiple sessions — you pay the setup cost every single time.

CodeRoamer sandboxes persist. Stop mid-task, come back hours or days later, and your agent resumes with everything intact — no re-cloning, no reinstalling, no re-explaining context.

### Section: What persists
- Full filesystem, including uncommitted changes
- Installed dependencies and tools
- Running background processes
- Shell history and state

### FAQ

**Does "persistent" mean it costs money while I'm not using it?**
Sandboxes idle down when inactive, so you're not paying for compute you're not using — but your state is preserved either way.

**Can I still get a clean, ephemeral sandbox if I want one?**
[Only include if actually true of the product — flag for founder to confirm before publishing.]

**What's the underlying infrastructure?**
Fly.io today, with more sandbox providers planned.

---

## Notes for whoever implements this

- Every specific capability claim above (multi-agent support, "more providers planned," idle-billing behavior, whether a stateless/ephemeral mode exists) should be checked against actual current product behavior before publishing — this copy was written from the founder's description of the product, not from the shipped feature set.
- Suggested schema.org markup: `SoftwareApplication` on the homepage, `FAQPage` on each page's FAQ block.
- Internal linking: homepage → both supporting pages, and vice versa, using the exact anchor phrases ("from your phone", "persistent sandboxes") for topical relevance.
