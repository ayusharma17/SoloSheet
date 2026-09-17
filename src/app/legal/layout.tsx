import Link from "next/link";

export default function LegalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="min-h-screen bg-white px-5 py-12 text-black">
      <article className="mx-auto max-w-3xl">
        <Link className="text-sm font-bold uppercase tracking-widest underline" href="/">
          SoloSheet home
        </Link>
        <div className="mt-10 space-y-8 leading-7 text-neutral-800">{children}</div>
      </article>
    </main>
  );
}
