import Link from "next/link";
import { ctaHref, ctaLabel, navLinks, site } from "@/lib/site";

export function Nav() {
  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur sticky top-0 z-40">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-zinc-100">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
          {site.name}
        </Link>
        <nav className="hidden gap-6 text-sm text-zinc-400 md:flex">
          {navLinks.slice(1).map((link) => (
            <Link key={link.href} href={link.href} className="hover:text-zinc-100 transition-colors">
              {link.label}
            </Link>
          ))}
        </nav>
        <Link
          href={ctaHref}
          className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-emerald-300"
        >
          {ctaLabel}
        </Link>
      </div>
    </header>
  );
}
