import Link from "next/link";

const variants = [
  { href: "/", label: "V1 — Persona-led" },
  { href: "/home-b", label: "V2 — Punchy / outcome-first" },
  { href: "/home-c", label: "V3 — Problem/story-led" },
];

export function VariantBanner({ current }: { current: 0 | 1 | 2 }) {
  return (
    <div className="border-b border-amber-400/20 bg-amber-400/5">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-4 gap-y-2 px-6 py-2 text-xs text-amber-200/80">
        <span className="font-medium">Homepage draft — comparing variants:</span>
        {variants.map((v, i) => (
          <Link
            key={v.href}
            href={v.href}
            className={
              i === current
                ? "rounded-full bg-amber-400/20 px-3 py-1 font-medium text-amber-200"
                : "rounded-full px-3 py-1 text-amber-200/60 hover:text-amber-200"
            }
          >
            {v.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
