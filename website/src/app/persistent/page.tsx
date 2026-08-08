import type { Metadata } from "next";
import Link from "next/link";
import { Faq } from "@/components/Faq";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "Persistent Cloud Sandboxes for AI Coding Agents",
  description:
    "Most agent sandboxes are ephemeral — rebuilt from scratch every session. CodeRoamer's sandboxes persist, so your agent picks up exactly where it left off.",
  alternates: { canonical: "/persistent" },
};

const persists = [
  "Full filesystem, including uncommitted changes",
  "Installed dependencies and tools",
  "Running background processes",
  "Shell history and state",
];

const faqItems = [
  {
    question: "Does “persistent” mean it costs money while I'm not using it?",
    answer:
      "Sandboxes idle down when inactive, so you're not paying for compute you're not using — but your state is preserved either way.",
  },
  {
    question: "What's the underlying infrastructure?",
    answer: "Fly.io today, with more sandbox providers planned.",
  },
];

export default function PersistentPage() {
  return (
    <>
      <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">
          Persistent, not ephemeral
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
          Most agent sandboxes forget everything. Ours don&apos;t.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          Ephemeral sandboxes rebuild your environment from zero every time. CodeRoamer&apos;s
          sandboxes are persistent — your agent&apos;s filesystem, dependencies, and shell state
          survive between sessions.
        </p>
        <Link
          href={ctaHref}
          className="mt-8 inline-block rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
        >
          Start a session
        </Link>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100">
            Why &quot;ephemeral&quot; is the wrong default for real work.
          </h2>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            A lot of agent sandbox infrastructure treats every session as disposable: clone the
            repo, install dependencies, run the task, throw the environment away. That&apos;s fine
            for a single isolated task. It&apos;s wasteful and slow if you&apos;re actually working
            on something over multiple sessions — you pay the setup cost every single time.
          </p>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            CodeRoamer sandboxes persist. Stop mid-task, come back hours or days later, and your
            agent resumes with everything intact — no re-cloning, no reinstalling, no
            re-explaining context.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-zinc-100">What persists</h2>
        <ul className="mt-6 space-y-3">
          {persists.map((item) => (
            <li key={item} className="flex gap-3 text-zinc-300">
              <span className="text-emerald-400">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <Faq items={faqItems} />
    </>
  );
}
