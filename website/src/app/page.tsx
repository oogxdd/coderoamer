import type { Metadata } from "next";
import Link from "next/link";
import { Faq } from "@/components/Faq";
import { VariantBanner } from "@/components/VariantBanner";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "Run Claude Code and Codex From Your Phone, No Laptop Needed",
  description:
    "CodeRoamer spins up a persistent cloud sandbox and drops you into a chat with your coding agent. No home server, no laptop left on, no SSH setup.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Your coding agent, without the laptop",
    description:
      "One tap spawns a real cloud sandbox. Chat with Claude Code or Codex from your phone — nothing to leave running at home.",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "CodeRoamer",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "iOS, Android, Web",
  description:
    "Chat-first AI coding agent that spins up its own persistent cloud sandbox — no home server, no laptop left on.",
};

const whoItsFor = [
  {
    title: "No home server",
    body: "You don't run a NAS or a home lab. You still want a real sandbox, not just a chat window.",
  },
  {
    title: "Don't want to leave a laptop on",
    body: "Your laptop sleeps, travels, or gets closed. Your agent shouldn't stop because of it.",
  },
  {
    title: "On your phone, for real work",
    body: "Not just monitoring an agent running elsewhere — actually running it, from a phone, with nothing at home to keep alive.",
  },
];

const steps = [
  "Open CodeRoamer and start a chat.",
  "Tell it what you want to work on — it spawns a cloud sandbox behind the scenes.",
  "Your agent (Claude Code, Codex, or others) runs inside it with full shell + filesystem access.",
  "Close the app any time. The sandbox persists — reopen and keep going.",
];

const faqItems = [
  {
    question: "Do I need my own server?",
    answer: "No. CodeRoamer provisions the sandbox for you on demand.",
  },
  {
    question: "What happens when I close the app?",
    answer:
      "Your sandbox is persistent — it pauses rather than disappearing. Your files, running processes, and shell state are there when you come back.",
  },
  {
    question: "Which agents does it support?",
    answer: "Claude Code and Codex today, with more planned.",
  },
  {
    question: "Where do sandboxes run?",
    answer: "On Fly.io today, with more providers planned.",
  },
  {
    question: "Is this the same as Claude Code Remote Control or Codex Remote?",
    answer:
      "No — those let you control an agent that's already running on a machine you own. CodeRoamer provisions the machine (sandbox) too, so you don't need one.",
  },
];

export default function HomePage() {
  return (
    <>
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <VariantBanner current={0} />

      <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">
          Chat-first · Persistent cloud sandboxes
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
          Your coding agent, without the laptop.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          CodeRoamer spawns a persistent cloud sandbox and puts you straight into a chat with it.
          No home server, no SSH, nothing to keep powered on.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href={ctaHref}
            className="rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
          >
            Start a session
          </Link>
          <Link href="#how-it-works" className="text-sm font-medium text-zinc-300 hover:text-zinc-100">
            See how it works →
          </Link>
        </div>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-4xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100">
            You shouldn&apos;t need a home server to run a coding agent.
          </h2>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            Most ways to use Claude Code or Codex remotely assume you already have a machine
            somewhere — a laptop you leave open, a home server you SSH into, a VPS you provisioned
            yourself. If you don&apos;t have one of those, or don&apos;t want to leave it running,
            your options run out fast.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-zinc-100">Spin up a sandbox, not a server.</h2>
        <p className="mt-4 text-zinc-400 leading-relaxed">
          CodeRoamer gives you a chat. Behind it, one tap spins up a real, isolated cloud
          sandbox — not a shared container, not a toy REPL. Your agent runs there, with a full
          filesystem and shell, for as long as you need it.
        </p>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-4xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100">
            Close the app. Come back later. Nothing&apos;s lost.
          </h2>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            Sandboxes from CodeRoamer are persistent — when you&apos;re done, the sandbox pauses
            instead of disappearing. Come back tomorrow and your agent picks up exactly where it
            left off: same files, same shell history, same running processes. No re-cloning the
            repo, no reinstalling dependencies.
          </p>
          <Link href="/persistent" className="mt-4 inline-block text-sm font-medium text-emerald-400 hover:text-emerald-300">
            Read more about persistent sandboxes →
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-zinc-100">
          Built for developers without a machine to spare.
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {whoItsFor.map((item) => (
            <div key={item.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h3 className="font-medium text-zinc-100">{item.title}</h3>
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100">
            From chat message to running sandbox in seconds.
          </h2>
          <ol className="mt-8 space-y-6">
            {steps.map((step, i) => (
              <li key={step} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-400/10 text-sm font-semibold text-emerald-400">
                  {i + 1}
                </span>
                <p className="pt-1 text-zinc-300">{step}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <Faq items={faqItems} />

      <section className="border-t border-zinc-800/80">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold text-zinc-100">
            No laptop. No server. Just a chat and a sandbox.
          </h2>
          <Link
            href={ctaHref}
            className="mt-6 inline-block rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
          >
            Start a session
          </Link>
        </div>
      </section>
    </>
  );
}
