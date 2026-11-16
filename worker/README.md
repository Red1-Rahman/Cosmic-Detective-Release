# SPHEREx processing worker

Runs the FITS processing (astropy / Photutils / reproject) that must never run
inside Netlify Functions (PLAN.md item 2, "Worker, jobs, and cache"):

    Netlify (orchestration)  ->  Supabase processing_jobs queue
                             ->  this worker (polls, claims, processes)
                             ->  Supabase Storage products, keyed by versioned
                                 cache keys (worker/cache_key_cases.json)

## Contract

- **Claim atomically.** One job at a time via `POST /rpc/claim_processing_job`
  (SQL `for update skip locked`, see `supabase/migrations/20261105000000_processing_jobs.sql`).
  Apply `supabase/migrations/20261106000000_blink_pair_product.sql` to allow the
  `blink-pair` product before submitting registered comparison jobs.
  Apply `supabase/migrations/20261106010000_band_composite_product.sql` before
  submitting false-color channel-composite jobs.
- **Verify cutout support first.** Every download goes through bounded
  `verify_cutout_support()`; a response bigger than the cap, or anything that
  is not FITS, fails the job with that reason. Full MEFs are never downloaded.
- **Versioned cache keys.** Products upload to
  `spherex/<keyVersion>/<product>/<collection>/<obsId>/<detector>/<release>/<geo>/<paramsHash>`
  — identical strings to `netlify/lib/processing.mjs` (shared goldens in
  `worker/cache_key_cases.json`, locked by both test suites). Bump
  `KEY_VERSION` / `keyVersion` together when semantics change.
- **Failure is data.** Any error records `status: 'failed'` + `error_reason`
  on the job row; orchestration exposes it as `unavailable: <reason>` — never
  a silent fallback.

## Automatic GitHub Actions dispatch

The worker workflow has only a `workflow_dispatch` trigger. A portal button
does not start GitHub Actions directly: `spherex-job` inserts a row into
`public.processing_jobs`, then a Supabase Database Webhook must call Netlify's
`start-worker` function to dispatch `worker.yml`.

Configure these Netlify environment variables in the **Functions** scope:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the same project used by
  `VITE_SUPABASE_URL` (the function prefers `VITE_SUPABASE_URL` when available).
- `CD_GITHUB_DISPATCH_TOKEN`: a fine-grained token for this repository with Actions
  read/write access.
- `WORKER_WEBHOOK_SECRET`: a long random value; use the same value in the
  webhook's `x-webhook-secret` header.
- `GITHUB_REPO=Red1-Rahman/Cosmic-Detective-Release`,
  `GITHUB_WORKFLOW_FILE=worker.yml`, and `GITHUB_REF=main` (these are the
  function defaults, shown here for clarity).

In Supabase, create a Database Webhook for `public.processing_jobs`, event
**INSERT**, URL `https://cosmicdetective.netlify.app/.netlify/functions/start-worker`,
and header `x-webhook-secret: <same WORKER_WEBHOOK_SECRET>`. In the GitHub
repository, add Actions secrets `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` for the worker to claim and process queued jobs.

The queue insert must succeed before a webhook can fire. A cache hit creates no
new row and therefore does not dispatch a run. Check the portal's processing
message and the `processing_jobs` table first; a queued row with no Actions run
usually means the Database Webhook or its Netlify/GitHub credentials are not
configured.

## Product stages today

- `cutout-render`: verify-cutout → read-image (astropy) → stretch-render.
- `blink-pair`: downloads bounded cutouts and checks target-pixel WCS-WAVE.
  Requests can provide up to 8 same-detector/release reference candidates; the
  worker skips passband mismatches and registers the first candidate within the
  strict wavelength and bandwidth gates. It reprojects the matching IMAGE
  planes to a shared target-centered TAN grid and returns both epochs with a
  shared display stretch. This is visual comparison only: flags are not
  overlaid and it is not a difference or detection product.
- `band-composite`: accepts three distinct detector inputs from one collection
  and processing release, reprojects them to a common sky grid, and makes an
  independently stretched RGB view. It is false-color visualization, not a
  calibrated color measurement or spectrum.
- `photometry`: verifies the cutout, then fails closed with the missing science
  calibration requirements. No photometry artifact is currently published.

The earlier prototype incorrectly treated PSF cube planes as wavelength
samples and estimated pixel solid angle from the display WCS. SPHEREx PSF cube
planes are spatial zones and the PSF models are oversampled. Until the worker
loads the detector solid-angle map, science-grade CWAVE/CBAND calibrations, and
fits the correctly selected PSF/ePSF with validated uncertainty propagation,
photometry requests are marked failed and the portal cannot treat them as
available measurements. ZODI is a modeled background and must not be
subtracted twice when extraction is implemented.

## Run

From the repository root, install Python dependencies once, then run Netlify
Dev and the worker together:

    python -m pip install -r worker/requirements.txt
    npm run dev:all

`dev:all` launches Netlify CLI through `npx` and starts the Python worker. The
first launch downloads Netlify CLI if it is not already present in the npm
cache. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the root
`.env` file before starting; the worker loads that file automatically.

For local runs, the worker reads `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from the ignored root `.env` file. It also accepts
`SUPABASE_SERVICE_KEY` as a legacy name. Deployed workers should receive these
as environment secrets. The worker prints each claimed job and its completion
or failure, so a job that remains queued indicates no worker has claimed it.

    # tests (no network, no Supabase):
    python -m unittest discover -s worker/tests

## Deploy near IRSA

Cutouts come from `irsa.ipac.caltech.edu`; run this worker in a region close
to it (e.g. a small container host in us-west) with an egress allow-list for
`*.ipac.caltech.edu` and your Supabase project. The bundled Dockerfile is the
reference image (Python 3.11 slim + astropy stack, ~1 GB).
