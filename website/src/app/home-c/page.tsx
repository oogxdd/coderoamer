import type { Metadata } from "next";
import Link from "next/link";
import { VariantBanner } from "@/components/VariantBanner";
import { ctaHref } from "@/lib/site";

export const metadata: Metadata = {
  title: "CodeRoamer — What If Your Agent Brought Its Own Computer?",
  description:
    "It's late, your laptop's asleep, and you have an idea. CodeRoamer spins up a persistent cloud sandbox so your coding agent doesn't need your machine at all.",
  robots: { index: false, follow: true },
};

const vignettes = [
  {
    title: "The idea at 11pm",
    body: "You have a fix you want to try. Your laptop's charging in the other room. Normally that's where the idea dies until morning.",
  },
  {
    title: "The trip without a laptop bag",
    body: "You're away from your desk for a few days. You still want to nudge a project forward from your phone, without carrying a machine to do it.",
  },
  {
    title: "The \"I don't want a home server\" developer",
    body: "Setting up a NAS or a home lab just to have somewhere for an agent to live has always felt like overkill for what you actually need.",
  },
];

export default function HomeVariantC() {
  return (
    <>
      <VariantBanner current={2} />

      <section className="mx-auto max-w-3xl px-6 pt-20 pb-12">
        <h1 className="text-4xl font-semibold leading-tight tracking-tight text-zinc-50 sm:text-5xl">
          It&apos;s late. You have an idea. Your laptop&apos;s asleep in the other room.
        </h1>
        <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
          The usual options: get up and open the laptop, SSH into a home server you left running
          just in case, or let the idea wait until tomorrow. None of them are great.
        </p>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-2xl font-semibold text-zinc-100">
            What if the agent just brought its own computer?
          </h2>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            That&apos;s CodeRoamer. Open a chat, and instead of connecting to a machine you own,
            you get a fresh, persistent cloud sandbox — spun up on demand, with a real shell and
            filesystem, ready for your agent to work in. Nothing at home has to be left running.
            Nothing needs a VPN or an SSH key.
          </p>
          <p className="mt-4 text-zinc-400 leading-relaxed">
            And because the sandbox is persistent, not thrown away after each session, coming back
            tomorrow means picking up exactly where you left off — not starting over.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16">
        <h2 className="text-2xl font-semibold text-zinc-100 text-center">Sound familiar?</h2>
        <div className="mt-8 space-y-6">
          {vignettes.map((v) => (
            <div key={v.title} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6">
              <h3 className="font-medium text-zinc-100">{v.title}</h3>
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{v.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-zinc-800/80 bg-zinc-900/40">
        <div className="mx-auto max-w-4xl px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold text-zinc-100">
            No laptop. No server. Just a chat and a sandbox.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-zinc-400">
            Next time the idea shows up at 11pm, open CodeRoamer instead of getting up.
          </p>
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
