/**
 * GET /auth/confirmed — the page a Supabase email-confirmation link lands on.
 *
 * Unauthenticated, and deliberately a dead end. The extension's registration
 * flow (resolution A3) already decided that confirming an email does not sign
 * anyone in: the account exists, the user returns to Jambu and signs in there.
 * So this page has exactly one job — tell the person the confirmation worked
 * and send them back to the extension. It is not an auth callback.
 *
 * Privacy (CLAUDE.md §31). Supabase leaves `#access_token=...` in the address
 * bar of whichever tab opens this URL. A fragment is never transmitted to a
 * server, so the API cannot see it even in principle; what remains is the risk
 * that the *page* reads it. This page therefore ships no JavaScript at all.
 * That is the reason for the `assertNoScript` test and for the CSP below —
 * "we do not read the token" is a property of the document, not a promise.
 */
import type { FastifyInstance } from 'fastify';

/**
 * The confirmation document.
 *
 * Styles are inline because the API serves no static files and this is the
 * only page it will ever render; a stylesheet would mean adding static
 * serving for one file. Colours and radii are the approved Jambu tokens from
 * `apps/extension/src/ui/theme.css`, restated rather than imported — the API
 * cannot import from the extension, and the alternative (a hex value chosen
 * here) would be a second source of visual truth.
 *
 * No web font is requested: a third-party font request from a page reached by
 * clicking a link in one's email is exactly the kind of quiet data leak §9
 * rules out, and the system stack renders this well already.
 */
const CONFIRMED_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Email confirmed — Jambu</title>
    <style>
      :root {
        --jambu-canvas: #eef2f0;
        --jambu-surface: #ffffff;
        --jambu-border: #e6eae8;
        --jambu-ink: #1f2421;
        --jambu-ink-muted: #6b7280;
        --jambu-green: #2f7d53;
        --jambu-green-soft: #e8f3ec;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background:
          radial-gradient(120% 80% at 12% 0%, #f2f7f3 0%, transparent 60%),
          radial-gradient(90% 70% at 100% 10%, #eaf1f6 0%, transparent 55%),
          var(--jambu-canvas);
        color: var(--jambu-ink);
        font-family:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial,
          sans-serif;
        line-height: 1.55;
        -webkit-font-smoothing: antialiased;
      }

      main {
        width: 100%;
        max-width: 26rem;
        padding: 40px 32px;
        text-align: center;
        background: var(--jambu-surface);
        border: 1px solid var(--jambu-border);
        border-radius: 18px;
        box-shadow:
          0 1px 2px rgb(31 36 33 / 6%),
          0 8px 24px rgb(31 36 33 / 8%);
      }

      .tick {
        color: var(--jambu-green);
      }

      h1 {
        margin: 0 0 10px;
        font-size: 1.375rem;
        font-weight: 600;
        letter-spacing: -0.01em;
      }

      p {
        margin: 0;
        color: var(--jambu-ink-muted);
        font-size: 0.9375rem;
      }

      p + p {
        margin-top: 4px;
      }

      footer {
        margin-top: 28px;
        font-size: 0.8125rem;
        color: var(--jambu-ink-muted);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --jambu-canvas: #171a18;
          --jambu-surface: #1f2421;
          --jambu-border: #2f3633;
          --jambu-ink: #f2f5f3;
          --jambu-ink-muted: #a3ada8;
          --jambu-green: #6fc494;
          --jambu-green-soft: #23372c;
        }

        body {
          background: var(--jambu-canvas);
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Email confirmed <span class="tick">&#10003;</span></h1>
      <p>Your Jambu account is ready.</p>
      <p>Return to the Jambu extension and sign in.</p>
      <footer>Jambu &#10084;&#65039;</footer>
    </main>
  </body>
</html>
`;

export function registerAuthConfirmedRoute(app: FastifyInstance): void {
  app.get('/auth/confirmed', async (_request, reply) => {
    // `default-src 'none'` is the enforcement behind this file's promise: even
    // if a script were ever introduced here, the browser would refuse to run
    // it, so nothing can reach the token in the fragment. `no-referrer` keeps
    // the landing URL — which Supabase may decorate with query parameters —
    // out of any onward request.
    return reply
      .type('text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .send(CONFIRMED_PAGE);
  });
}
