export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-24 font-sans text-zinc-900 dark:bg-black dark:text-zinc-100">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
            UltraPlan / Phase 1
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            VisQuanta Blog Portal
          </h1>
          <p className="text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            Autonomous, source-grounded blog generation for{" "}
            <a
              href="https://visquanta.com"
              className="underline decoration-zinc-400 underline-offset-4 hover:decoration-zinc-900 dark:hover:decoration-zinc-100"
            >
              visquanta.com
            </a>
            . Three posts per week, five hard quality gates, human review on
            every draft.
          </p>
        </header>

        <section className="flex flex-col gap-3 border-l-2 border-zinc-300 pl-5 text-sm leading-relaxed text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">
            Core principles
          </p>
          <ol className="flex flex-col gap-1.5">
            <li>1. No source = no sentence.</li>
            <li>2. Reputable allowlist only.</li>
            <li>3. Five hard gates, none optional.</li>
            <li>4. Human reviews only what passed.</li>
            <li>5. Best model at every step.</li>
          </ol>
        </section>

        <footer className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-4 font-mono text-xs text-zinc-500">
          <span>Status: scaffolding</span>
          <span aria-hidden>·</span>
          <a
            href="https://github.com/visquanta-dev/ultraplan_cc"
            className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            visquanta-dev/ultraplan_cc
          </a>
        </footer>
      </div>
    </main>
  );
}
