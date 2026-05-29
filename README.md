# da-pdf-service

Internal PDF rendering microservice for the DealerAddendums platform. Runs Puppeteer + pdf-lib so the main app (da-platform) doesn't have to.

## Why it exists

PDF generation was competing with app traffic on the main da-platform EC2. Puppeteer is heavy — each headless Chrome page is 100–200 MB resident — and bulk addendum runs (hundreds of vehicles in one combined PDF) were spiking memory enough to slow user-facing requests. This service moves all Puppeteer / pdf-lib / S3-upload work to a dedicated `c6i.2xlarge` (8 vCPU, 16 GB RAM) so the main app keeps its headroom.

## Endpoints

All endpoints under `/api/pdf/*` require `X-API-Key: $PDF_SERVICE_API_KEY` and return 401 otherwise. `/api/health` is unauthenticated for load-balancer probes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`  | `/api/health` | Liveness + env-configuration probe. |
| `POST` | `/api/pdf/generate` | Render one HTML payload to a single-page addendum/infosheet PDF and upload to S3. Body: `{ html, s3KeyHint? }`. Returns `{ jobId }`. |
| `POST` | `/api/pdf/bulk` | Render N HTML payloads and merge into one PDF. Body: `{ jobs: [{ html }, ...], s3KeyHint? }`. Returns `{ jobId }`. |
| `POST` | `/api/pdf/buyer-guide` | Overlay FTC Buyer's Guide fields onto a static template PDF via pdf-lib. Body: `{ templateKey, fields, s3KeyHint? }`. Returns `{ jobId }`. |
| `GET`  | `/api/pdf/status/:jobId` | Poll for `pending` / `running` / `complete` / `failed`. On `complete`, response carries `s3Key` and a 15-minute pre-signed `signedUrl`. |

## Async contract

Every render endpoint is async — POST returns a `jobId` immediately, render happens in the worker, da-platform polls `/status/:jobId`. The polling client should:

1. POST → grab `jobId`
2. Poll `GET /status/:jobId` every 1–2 seconds
3. On `status: "complete"`, redirect or download `signedUrl`
4. On `status: "failed"`, surface `error` to the user
5. Give up after ~60 seconds of `pending`/`running` and treat as failure

## Deployment

- Infra: c6i.2xlarge, Ubuntu, no public IP, NAT egress, SG allows port 22 + port 3001 from da-platform private IP only.
- Server bootstrap (Node 20, PM2, Chrome deps) is in [`docs/bootstrap.md`](docs/bootstrap.md).
- Process manager: PM2, config in `ecosystem.config.js`.
- Logs land in `/var/log/da-pdf-service/{out,err}.log`.

```bash
git pull
npm ci --omit=dev
pm2 reload ecosystem.config.js --update-env
```

## Local development

```bash
cp .env.example .env
# fill in PDF_SERVICE_API_KEY, AWS_*, S3_BUCKET
npm install
npm run dev
curl http://localhost:3001/api/health
```

## Repo conventions

- This service stays small. The HTML template generator (`lib/pdf-html.ts`) lives in da-platform and is sent over the wire — the PDF service is dumb about what's in the page, it just renders.
- No Supabase, no Postgres, no Aurora. Job state lives in memory; if we scale beyond one instance later, swap `src/lib/job-store.js` for Redis.
- Same `dealer-addendums` S3 bucket as the main app, same key conventions.
