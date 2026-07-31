import Link from "next/link";

export function LegalPage({
  title,
  children,
}: Readonly<{
  title: string;
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-8 text-zinc-700 dark:text-zinc-300">
        <header className="flex flex-col gap-2 border-b border-zinc-200 pb-6 dark:border-zinc-800">
          <Link href="/" className="text-sm text-zinc-500 underline dark:text-zinc-400">
            OmniPost
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            {title}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Effective July 31, 2026
          </p>
        </header>
        <article className="flex flex-col gap-6 leading-7 [&_h2]:text-xl [&_h2]:font-medium [&_h2]:text-black dark:[&_h2]:text-zinc-50 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
          {children}
        </article>
      </main>
    </div>
  );
}
