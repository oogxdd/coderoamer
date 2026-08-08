export type FaqItem = {
  question: string;
  answer: string;
};

export function Faq({ items, title = "FAQ" }: { items: FaqItem[]; title?: string }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  return (
    <section className="mx-auto max-w-3xl px-6 py-16">
      <h2 className="text-2xl font-semibold text-zinc-100">{title}</h2>
      <dl className="mt-8 space-y-8">
        {items.map((item) => (
          <div key={item.question} className="border-b border-zinc-800 pb-8 last:border-0">
            <dt className="font-medium text-zinc-100">{item.question}</dt>
            <dd className="mt-2 text-zinc-400 leading-relaxed">{item.answer}</dd>
          </div>
        ))}
      </dl>
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </section>
  );
}
