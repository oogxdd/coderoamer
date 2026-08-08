import type { Metadata } from "next";
import Link from "next/link";
import { Faq } from "@/components/Faq";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "Run a Coding Agent From Your Phone — No SSH, No Setup",
  description:
    "Skip Termux, Tailscale, and SSH keys. CodeRoamer lets you run Claude Code or Codex from your phone by spawning a cloud sandbox — just open a chat.",
  alternates: { canonical: "/phone" },
};

const oldWay = [
  "Set up Tailscale between your phone and a machine",
  "Install Termux, configure a terminal",
  "SSH in, start tmux so sessions survive disconnects",
  "Keep that machine powered on and reachable",
];

const newWay = ["Open the app", "Start a chat", "Your agent is already running in its own sandbox"];

const faqItems = [
  {
    question: "Is this a terminal emulator?",
    answer: "No. Chat is the primary interface; a terminal is available as a secondary tool when you need it.",
  },
  {
    question: "Do I need to configure networking, VPNs, or tunnels?",
    answer: "No. There's no machine of yours to reach — CodeRoamer's sandbox is already reachable through the app.",
  },
  {
    question: "What if I lose connection mid-task?",
    answer: "The sandbox keeps running. Reopen the app and reconnect to the same session.",
  },
];

export default function PhonePage() {
  return (
    <>
      <section className="mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">From your phone</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
          Run a real coding agent from your phone. No SSH required.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          Forget Termux, Tailscale tunnels, and SSH keys. Open CodeRoamer, send a message, and
          your agent is running in its own cloud sandbox.
        </p>
        <Link
          href={ctaHref}
          className="mt-8 inline-block rounded-full bg-emerald-400 px-6 py-3 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-300"
        >
          Start a session
        </Link>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100 text-center">
            The old way vs. the CodeRoamer way
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6">
              <h3 className="font-medium text-zinc-400">The DIY way</h3>
              <ul className="mt-4 space-y-3 text-sm text-zinc-500">
                {oldWay.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-zinc-600">–</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-6">
              <h3 className="font-medium text-emerald-400">The CodeRoamer way</h3>
              <ul className="mt-4 space-y-3 text-sm text-zinc-200">
                {newWay.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-emerald-400">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-zinc-100">
          Why chat beats terminal-over-SSH on mobile.
        </h2>
        <p className="mt-4 text-zinc-400 leading-relaxed">
          A terminal is a keyboard-and-cursor interface designed for a desk. On a phone, typing
          shell commands over a shaky connection is the worst part of remote coding.
          CodeRoamer&apos;s primary interface is chat — the same interaction model your phone is
          actually good at — with the terminal available only when you need to drop into it.
        </p>
      </section>

      <Faq items={faqItems} />
    </>
  );
}
