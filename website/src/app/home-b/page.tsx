import type { Metadata } from "next";
import Link from "next/link";
import { VariantBanner } from "@/components/VariantBanner";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "CodeRoamer — Spawn a Coding Agent in Seconds",
  description:
    "No laptop, no SSH, no lost progress. CodeRoamer spins up a persistent cloud sandbox and drops your coding agent straight into it.",
  robots: { index: false, follow: true },
};

const badges = ["No laptop needed", "No SSH setup", "No lost progress"];

const features = [
  { title: "Instant sandbox", body: "A real cloud environment, running seconds after you ask for it." },
  { title: "Persistent state", body: "Pause and resume. Files, processes, and shell history stay put." },
  { title: "Chat native", body: "Talk to your agent. Drop into a terminal only when you actually need one." },
  { title: "Works from any device", body: "Phone, tablet, laptop — the sandbox lives in the cloud, not on your desk." },
  { title: "Full shell + filesystem", body: "Not a toy REPL. Real access, real tools, real git." },
  { title: "Claude Code & Codex", body: "Bring the agent you already use. More on the way." },
];

const steps = ["Open a chat", "Sandbox spins up", "Agent gets to work"];

export default function HomeVariantB() {
  return (
    <>
      <VariantBanner current={1} />

      <section className="mx-auto max-w-4xl px-6 pt-20 pb-10 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-50 sm:text-6xl">
          Spawn a coding agent in seconds.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-zinc-400">
          Not a remote control for a machine you already own. An actual machine, on demand.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {badges.map((b) => (
            <span
              key={b}
              className="rounded-full border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300"
            >
              {b}
            </span>
          ))}
        </div>
        <Link
          href={ctaHref}
          className="mt-10 inline-block rounded-full bg-emerald-400 px-8 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
        >
          Start a session
        </Link>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-center">
            {steps.map((step, i) => (
              <div key={step} className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-400/10 text-sm font-semibold text-emerald-400">
                  {i + 1}
                </span>
                <span className="text-zinc-200">{step}</span>
                {i < steps.length - 1 && <span className="hidden text-zinc-600 sm:inline">→</span>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-16">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h3 className="font-medium text-zinc-100">{f.title}</h3>
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

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
