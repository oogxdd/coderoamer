import type { Metadata } from "next";
import { Faq } from "@/components/Faq";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Answers about how CodeRoamer's cloud sandboxes, agents, and pricing work.",
  alternates: { canonical: "/faq" },
};

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
  {
    question: "Does “persistent” mean it costs money while I'm not using it?",
    answer:
      "Sandboxes idle down when inactive, so you're not paying for compute you're not using — but your state is preserved either way.",
  },
];

export default function FaqPage() {
  return (
    <section className="mx-auto max-w-4xl px-6 pt-20">
      <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">FAQ</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-50">
        Frequently asked questions
      </h1>
      <Faq items={faqItems} title="" />
    </section>
  );
}
