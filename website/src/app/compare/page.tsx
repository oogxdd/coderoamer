import type { Metadata } from "next";
import Link from "next/link";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "CodeRoamer vs. Remote-Control Apps vs. DIY SSH",
  description:
    "How CodeRoamer compares to remote-control mobile apps, DIY SSH/Tailscale setups, and team task-runner platforms for running AI coding agents.",
  alternates: { canonical: "/compare" },
};

const rows: { label: string; roamer: string; remoteControl: string; diy: string; taskRunner: string }[] = [
  {
    label: "Provisions compute for you",
    roamer: "Yes — spawns a sandbox on demand",
    remoteControl: "No — controls a machine you already have",
    diy: "No — you supply the box",
    taskRunner: "Yes, but as infra for teams/automation",
  },
  {
    label: "Needs a home server or always-on laptop",
    roamer: "No",
    remoteControl: "Yes",
    diy: "Yes",
    taskRunner: "No",
  },
  {
    label: "Primary interface",
    roamer: "Chat",
    remoteControl: "Terminal / chat over your own session",
    diy: "Terminal",
    taskRunner: "Slack / Linear / Sentry triggers",
  },
  {
    label: "State between sessions",
    roamer: "Persistent sandbox, picks up where you left off",
    remoteControl: "Depends on your own machine staying up",
    diy: "Depends on your own machine staying up",
    taskRunner: "Usually rebuilt per task (ephemeral)",
  },
  {
    label: "Setup",
    roamer: "Open the app",
    remoteControl: "Install app + pair with your running agent",
    diy: "Tailscale + Termux + SSH keys + tmux",
    taskRunner: "Connect repo + integrations",
  },
  {
    label: "Built for",
    roamer: "An individual developer without spare hardware",
    remoteControl: "Someone who already leaves a machine running",
    diy: "Technical users comfortable stitching tools together",
    taskRunner: "Teams automating background coding tasks",
  },
];

export default function ComparePage() {
  return (
    <>
      <section className="mx-auto max-w-4xl px-6 pt-20 pb-12 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">Compare</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
          Four ways to run a coding agent remotely.
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          Most tools in this space assume you already have a machine somewhere. CodeRoamer is the
          one that gives you the machine too.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="overflow-x-auto rounded-2xl border border-zinc-800">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-zinc-300">
                <th className="p-4 font-medium">&nbsp;</th>
                <th className="p-4 font-medium text-emerald-400">CodeRoamer</th>
                <th className="p-4 font-medium">Remote-control apps</th>
                <th className="p-4 font-medium">DIY (SSH + Tailscale)</th>
                <th className="p-4 font-medium">Team task-runner platforms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.label} className={i % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900/30"}>
                  <td className="p-4 font-medium text-zinc-200">{row.label}</td>
                  <td className="p-4 text-zinc-100">{row.roamer}</td>
                  <td className="p-4 text-zinc-400">{row.remoteControl}</td>
                  <td className="p-4 text-zinc-400">{row.diy}</td>
                  <td className="p-4 text-zinc-400">{row.taskRunner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          &quot;Remote-control apps&quot; refers to mobile clients for a coding agent already
          running on your own machine. &quot;Team task-runner platforms&quot; refers to services
          that run autonomous coding tasks triggered from tools like Slack or Linear. Categories
          are generalized for comparison; specific products vary.
        </p>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
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
