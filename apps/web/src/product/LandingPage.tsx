/**
 * Public product home page: the logged-out front door.
 *
 * Narrative per design-docs/homepage-narrative.md (2026-10-22, governs):
 * the product is an AI-native data workspace — data processing and data
 * visualization are the core; the spreadsheet is the surface the data
 * lives on, not the product. The page is organized by the data pipeline,
 * in order: the agent first (the headline), Connect, Process, Visualize,
 * Share — and Excel parity LAST, as one brief credibility strip, never
 * the headline. A visitor should know within seconds what this is and
 * what it is not (not an Excel clone with a chatbot bolted on).
 *
 * Every number on the page is traceable to the program records (517 of
 * Excel's 523 functions — FUNCTION-LIST-AND-GAPS.md; the published
 * benchmark at 463/465 = 99.57%; the agent exchange below is from a real
 * validation run, agent proof case 1). Screenshots are real captures of
 * the current build (see hidden_files/homepage-narrative/REPORT.md for
 * the image audit).
 *
 * Sign-in on this page is exactly one action: "Sign in with Google"
 * (the user's 2026-10-22 ruling). In the production flavor the button
 * fires the Firebase Google sign-in DIRECTLY — App wires onSignIn
 * straight to it, one click, no intermediate dialog; a cancelled or
 * failed popup reports back through signInError (shown in place) and
 * the button re-arms. Only local/test builds route the button to the
 * dev login gate, which carries the user-ID field alongside Google.
 *
 * Standalone by design: renders from props only, owns no routing or
 * auth state. Reveal animations are progressive enhancement — content
 * is fully visible without IntersectionObserver and under
 * prefers-reduced-motion.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './product.css';
import { buildHomeUrl } from './deepLink';

export interface LandingPageProps {
  loggedIn: boolean;
  onSignIn: () => void;
  onOpenWorkspace: () => void;
  /** Direct sign-in in flight (production flavor): buttons show busy. */
  signInBusy?: boolean;
  /** Direct sign-in failed/cancelled: message shown in place. */
  signInError?: string | null;
}

/** Scroll-reveal wrapper: fades/rises children in when they enter the viewport. */
function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`ics-lp-reveal${shown ? ' ics-lp-in' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

/** The Google "G" mark, as on the app's own Google sign-in buttons. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}

export function LandingPage({
  loggedIn,
  onSignIn,
  onOpenWorkspace,
  signInBusy,
  signInError,
}: LandingPageProps) {
  const primaryAction = loggedIn ? onOpenWorkspace : onSignIn;

  const signInButton = (extraClass: string) =>
    loggedIn ? (
      <button type="button" className={`ics-lp-btn ics-lp-btn-primary ${extraClass}`} onClick={primaryAction}>
        Open workspace
      </button>
    ) : (
      <button
        type="button"
        className={`ics-lp-btn ics-lp-btn-google ${extraClass}`}
        onClick={primaryAction}
        disabled={signInBusy}
      >
        <GoogleG />
        {signInBusy ? 'Signing in with Google…' : 'Sign in with Google'}
      </button>
    );

  const signInErrorNote = !loggedIn && signInError ? (
    <p className="ics-lp-signin-error" role="alert">
      {signInError}
    </p>
  ) : null;

  return (
    <div className="ics-landing">
      <header className="ics-lp-nav">
        <a className="ics-wordmark-link" href={buildHomeUrl()} aria-label="Icecream Sheets — home">
          <span className="ics-wordmark">
            Icecream<span className="ics-wordmark-accent"> Sheets</span>
          </span>
        </a>
        {signInButton('ics-lp-nav-btn')}
      </header>

      <main>
        <section className="ics-lp-hero">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-hero-eyebrow">An AI-native data workspace</p>
              <h1 className="ics-lp-hero-title">
                An AI that works on your data — in a real spreadsheet.
              </h1>
              <p className="ics-lp-hero-sub">
                Other tools added AI to a spreadsheet. This is the other way around: the agent is
                the product, and the spreadsheet is how you watch it work. Bring a file, a CSV, or
                a live database — the agent cleans it, calculates it, and charts it, in the grid
                in front of you.
              </p>
              {signInButton('ics-lp-hero-btn')}
              {signInErrorNote}
            </Reveal>
            <Reveal className="ics-lp-hero-shot-wrap">
              <img
                className="ics-lp-shot"
                src="/product/agent-work.png"
                srcSet="/product/agent-work-960.png 960w, /product/agent-work.png 1600w"
                sizes="(max-width: 720px) 100vw, 1080px"
                alt="The Icecream Sheets agent at work beside a sales spreadsheet: told to add up the revenue column, it writes the total — 4027.86 — into the grid and confirms it in the panel, while the data stays in view."
              />
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section ics-lp-alt" aria-label="Watch it work">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Watch it work</p>
              <h2 className="ics-lp-title">
                Watch the agent do a whole job, start to finish.
              </h2>
              <p className="ics-lp-text ics-lp-lede">
                An agent loads a real dataset, runs the analysis, and renders the charts — all in
                the sheet, in under four minutes.
              </p>
            </Reveal>
            <Reveal>
              <video
                className="ics-lp-video"
                src="/product/demo.mp4"
                poster="/product/demo-poster.jpg"
                controls
                preload="metadata"
                playsInline
              >
                Your browser can&rsquo;t play this video.
              </video>
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section" aria-labelledby="ics-lp-agent">
          <div className="ics-lp-wrap ics-lp-split">
            <Reveal className="ics-lp-copy">
              <p className="ics-lp-eyebrow">The agent</p>
              <h2 className="ics-lp-title" id="ics-lp-agent">
                Ask. It answers. Tell it. It&rsquo;s done.
              </h2>
              <p className="ics-lp-text">
                The agent works in the sheet in front of you, through the same tools you use. There
                is no separate chatbot and no copy-paste. An answer comes from your cells. A change
                it makes is a real change — calculated, saved, and visible to everyone in the file.
                You watch every step in the grid, and you can stop it, undo it, or do it yourself
                instead.
              </p>
            </Reveal>
            <Reveal className="ics-lp-card-wrap">
              <figure className="ics-lp-chat">
                <div className="ics-lp-chat-row">
                  <span className="ics-lp-chat-who">You</span>
                  <p className="ics-lp-chat-text">
                    What&rsquo;s the total revenue in the Sales sheet?
                  </p>
                </div>
                <div className="ics-lp-chat-row">
                  <span className="ics-lp-chat-who ics-lp-chat-agent">Agent</span>
                  <p className="ics-lp-chat-text ics-lp-chat-answer">$159,400</p>
                </div>
                <figcaption className="ics-lp-chat-caption">
                  A real question, answered from the sheet&rsquo;s own cells.
                </figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section ics-lp-alt" aria-labelledby="ics-lp-connect">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Connect</p>
              <h2 className="ics-lp-title" id="ics-lp-connect">
                Your data stays where it lives. The sheet comes to it.
              </h2>
              <p className="ics-lp-text ics-lp-lede">
                A spreadsheet here is a view, not a file you export and forget. Connect a source and
                the grid shows that data. Change a number, and the charts and pivots built on it
                move too — because they were never copies.
              </p>
            </Reveal>
            <Reveal>
              <ul className="ics-lp-facts">
                <li className="ics-lp-fact">
                  <span className="ics-lp-fact-term">Excel files</span>
                  <span className="ics-lp-fact-line">Open them, edit them, save them back — intact.</span>
                </li>
                <li className="ics-lp-fact">
                  <span className="ics-lp-fact-term">CSV</span>
                  <span className="ics-lp-fact-line">Upload one and it becomes a workbook that calculates.</span>
                </li>
                <li className="ics-lp-fact">
                  <span className="ics-lp-fact-term">REST and SQL</span>
                  <span className="ics-lp-fact-line">Point it at an API or a database and the rows arrive as a grid you can work in.</span>
                </li>
              </ul>
            </Reveal>
            <Reveal>
              <img
                className="ics-lp-shot"
                src="/product/connect-source.png"
                srcSet="/product/connect-source-960.png 960w, /product/connect-source.png 1600w"
                sizes="(max-width: 720px) 100vw, 1080px"
                alt="Connecting a data source in Icecream Sheets: rows from an outside source open as a live grid that calculates like any other sheet."
              />
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section" aria-labelledby="ics-lp-process">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Process</p>
              <h2 className="ics-lp-title" id="ics-lp-process">
                The cleaning and joining is a sentence now.
              </h2>
              <p className="ics-lp-text ics-lp-lede">
                Tell the agent what you need — clean this column, join these two tables, total this
                up by region. It writes the formulas, or Python when formulas are the wrong tool,
                and runs them on your data, not on a copy. Set a trigger, and the same work runs
                again whenever the data changes. And when a formula is not enough, your own Python
                or JavaScript functions run in a secure sandbox — and you call them straight from a
                formula, like any built-in.
              </p>
            </Reveal>
            <Reveal>
              <img
                className="ics-lp-shot"
                src="/product/pivotchart.png"
                srcSet="/product/pivotchart-960.png 960w, /product/pivotchart.png 1600w"
                sizes="(max-width: 720px) 100vw, 1080px"
                alt="Raw sales rows in Icecream Sheets turned into a pivot table and a chart of revenue by region, in the same sheet — the processing and the picture, side by side."
              />
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section ics-lp-alt" aria-labelledby="ics-lp-visualize">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Visualize</p>
              <h2 className="ics-lp-title" id="ics-lp-visualize">
                Ask a question. Get the picture.
              </h2>
              <p className="ics-lp-text ics-lp-lede">
                Charts sit inside the sheet, drawn from the numbers next to them — open a file and
                they are already there. Ask the agent for a view you do not have yet, and it builds
                the chart, or a small live app, in the same conversation.
              </p>
            </Reveal>
            <Reveal>
              <img
                className="ics-lp-shot"
                src="/product/hero-dashboard.png"
                srcSet="/product/hero-dashboard-960.png 960w, /product/hero-dashboard.png 1600w"
                sizes="(max-width: 720px) 100vw, 1080px"
                alt="A financial workbook open in Icecream Sheets: revenue, growth, and cash-flow charts sit inside the sheet, next to the numbers they come from."
              />
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section" aria-labelledby="ics-lp-share">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Share</p>
              <h2 className="ics-lp-title" id="ics-lp-share">
                One sheet. Everyone in it. Live.
              </h2>
              <p className="ics-lp-text ics-lp-lede">
                Share a file and everyone edits the same copy, in the same live data — a change
                appears the moment it happens, and there are no merges to resolve. Share an app the
                agent built and it travels with its data: whoever opens it gets their own copy to
                work in.
              </p>
            </Reveal>
            <Reveal>
              <img
                className="ics-lp-shot"
                src="/product/collab.png"
                srcSet="/product/collab-960.png 960w, /product/collab.png 1500w"
                sizes="(max-width: 720px) 100vw, 1080px"
                alt="Two people editing the same workbook at once, their changes together in one grid."
              />
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section ics-lp-alt ics-lp-strip-section" aria-labelledby="ics-lp-proof">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">And underneath, a real spreadsheet</p>
              <h2 className="ics-lp-strip-title" id="ics-lp-proof">
                Your Excel files, exactly as Excel left them.
              </h2>
            </Reveal>
            <Reveal>
              <div className="ics-lp-strip">
                <p className="ics-lp-strip-item">
                  <strong>517 of Excel&rsquo;s 523 functions</strong> work here — implemented and
                  tested, one by one.
                </p>
                <p className="ics-lp-strip-item">
                  <strong>99.57% on the published benchmark</strong> — 463 of 465 checks matched
                  Excel, and{' '}
                  <a
                    className="ics-lp-link"
                    href="https://github.com/is-cream/icecream-sheets-benchmark"
                    target="_blank"
                    rel="noreferrer"
                  >
                    anyone can re-run it
                  </a>
                  .
                </p>
                <p className="ics-lp-strip-item">
                  <strong>Files round-trip losslessly</strong> — open, edit, save, and a byte-level
                  audit finds nothing missing.
                </p>
              </div>
              <p className="ics-lp-strip-note">
                Built on a <strong>deterministic, multithreaded calculation engine</strong>,
                exposed through a <strong>versioned MCP server</strong> — the same surface the
                agent works through.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-section" aria-labelledby="ics-lp-plans">
          <div className="ics-lp-wrap">
            <Reveal>
              <p className="ics-lp-eyebrow">Plans</p>
              <h2 className="ics-lp-title" id="ics-lp-plans">
                Start on Default. Move up when you outgrow it.
              </h2>
            </Reveal>
            <Reveal>
              <div className="ics-lp-tiers">
                <article className="ics-lp-tier">
                  <h3 className="ics-lp-tier-name">Default</h3>
                  <p className="ics-lp-tier-tag">Everything, with two caps.</p>
                  <ul className="ics-lp-tier-list">
                    <li>Uploads up to ~1.3 MB per file</li>
                    <li>Up to 10 files in your workspace</li>
                    <li>Create new spreadsheets of any size</li>
                    <li>Formulas, charts, pivots, and co-authoring included</li>
                  </ul>
                </article>
                <article className="ics-lp-tier ics-lp-tier-pro">
                  <h3 className="ics-lp-tier-name">Pro</h3>
                  <p className="ics-lp-tier-tag">The caps, removed.</p>
                  <ul className="ics-lp-tier-list">
                    <li>Uploads of any size</li>
                    <li>As many files as you need</li>
                    <li>Everything in Default</li>
                  </ul>
                </article>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="ics-lp-final">
          <div className="ics-lp-wrap">
            <Reveal>
              <h2 className="ics-lp-final-title">Bring your data. Ask the first question.</h2>
              {signInButton('ics-lp-hero-btn')}
              {signInErrorNote}
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="ics-lp-footer">
        <span>Icecream Sheets — an AI-native data workspace, on a real spreadsheet.</span>
        <span className="ics-lp-builders">
          <img
            className="ics-lp-builders-avatar"
            src="/icecream-avatar.jpg"
            alt="Icecream, the AI co-builder of this app"
            width="28"
            height="28"
          />
          <span>Built by Debajyoti and Icecream — a person and his AI, building together.</span>
        </span>
        <a
          className="ics-lp-link"
          href="https://github.com/is-cream/icecream-sheets-benchmark"
          target="_blank"
          rel="noreferrer"
        >
          Published benchmark results
        </a>
      </footer>
    </div>
  );
}
