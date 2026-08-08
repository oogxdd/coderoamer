import type { Metadata } from "next";
import { StartForm } from "./StartForm";

export const metadata: Metadata = {
  title: "Start a Session",
  description: "Get notified when CodeRoamer is ready for you.",
  alternates: { canonical: "/start" },
};

export default function StartPage() {
  return (
    <section className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">Start a session</h1>
      <p className="mt-4 text-zinc-400">
        CodeRoamer is early. Leave your email and we&apos;ll let you know the moment you can spawn
        your first sandbox.
      </p>
      <div className="mt-8">
        <StartForm />
      </div>
    </section>
  );
}
