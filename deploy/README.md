# Earrr deployment

## Current deployment

| Item                             | Location / setting                                                             |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Public application               | **https://earrr.app**                                                          |
| Also bound with HTTPS            | https://www.earrr.app                                                          |
| Azure validation host            | https://earrr-prod-54cd1f78.azurewebsites.net                                  |
| GitHub                           | https://github.com/jiin-kim109/Earrr                                           |
| Subscription                     | `54cd1f78-ae06-4388-9e52-15b452f21c10`, explicitly approved by the owner       |
| Resource group                   | `rg-earrr-prod`                                                                |
| Web app                          | `earrr-prod-54cd1f78`                                                          |
| Hosting plan                     | `asp-earrr-prod`, Linux **B1**, one worker, **West US 3**                      |
| Runtime                          | Node 22 LTS; `node dist/server/main.js`, port 8080                             |
| Secrets                          | Azure Key Vault `kv-earrr-prod-54cd1f78`, Standard/RBAC, West US 2             |
| Supabase project                 | `smxezziivohyldytykzv`, existing Auth/PostgreSQL learning storage              |
| Deployment workflow              | `.github/workflows/ci.yml`                                                     |
| Verified first automatic release | `20261003T055448Z-e9b8f643`, source `e9b8f643b0232c79cb32aef39008087f6f03d1ef` |

On October 3, 2026 UTC, the custom HTTPS hosts and Azure host returned healthy
responses with the exact embedded release/commit. The live browser, secure
microphone context, owner-scoped guest hydration, native WebRTC coaching,
hidden-tab replay/grading and microphone release were verified using an isolated
test guest. No existing user's learning was scored or changed.

**Pipeline status: verified end to end.** GitHub run
[`37101037162`](https://github.com/jiin-kim109/Earrr/actions/runs/37101037162)
passed Linux CI/browser checks, immutable packaging, the real Azure OIDC exchange,
Kudu deployment receipt, exact release/commit and infrastructure verification, and
automatic Git tag/release publication. The first successful release is
[`20261003T055448Z-e9b8f643`](https://github.com/jiin-kim109/Earrr/releases/tag/20261003T055448Z-e9b8f643).

Azure CLI's separate runtime tracker previously reported a false-negative despite
Kudu success and successful platform startup probes. Delivery uses
`--track-status false` while still requiring a successful synchronous Kudu receipt
and exact new-version health. Submission errors, malformed receipts, stale
versions and failed verification remain fatal; no catch-and-success fallback is used.

The subscription name remains Visual Studio Enterprise Subscription. The owner
acknowledged the offer guidance and expressly selected this existing subscription;
no billing upgrade, spending-limit removal or unrelated subscription change was
performed. This is not a reclassification of the subscription offer.

## Hosting and cost

One always-on B1 worker avoids cold-start setup delays and keeps transient SQL
execution workspaces on a single instance. Persistent learning/chat remains in
Supabase for accounts and encrypted browser saves for guests. No ACR, Container
Apps, extra database, paid staging slot or autoscaling resource was added.

The Azure Retail Prices API checked on October 3, 2026 lists West US 3 Linux B1
at **USD $0.017/hour**, approximately **$12.41 per 730 hours**. Standard Key Vault
operations are approximately **$0.03 per 10,000 operations**. Taxes, bandwidth,
Azure OpenAI, Supabase, Resend and registrar charges are separate. Stopping the web
app does not stop plan billing.

West US 2 B1 creation was rejected by quota 0; West US 3 succeeded without
increasing the SKU or worker count.

HTTPS-only, TLS 1.2 minimum, Always On and exact configured host/origin checks are
enabled. FTP/basic publishing authentication is disabled. Hosting accepts only
the root, owned `www` and Azure default origins. Mutations require
`x-earrr-client: 1`; forwarded headers cannot broaden trust.

## DNS and HTTPS

GoDaddy remains the registrar/DNS provider. Existing mail records were preserved.
The owner removed the protected Website Builder apex record, so GoDaddy no longer
routes the apex to its old AWS website service.

| Record                      | Value                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| Apex `A @`                  | `20.40.24.37`                                                        |
| `CNAME www`                 | `earrr.app.` (existing protected record; resolves to the Azure apex) |
| `TXT asuid`                 | Azure custom-domain verification ID in `config.json`                 |
| `TXT asuid.www`             | Same Azure verification ID                                           |
| `TXT resend._domainkey`     | Existing verified Resend DKIM public key                             |
| `CNAME send`, `CNAME rsend` | Existing Resend/provider records                                     |
| `TXT _dmarc`                | Existing DMARC policy                                                |

Both hostnames are verified and SNI-bound to free App Service Managed Certificates:

| Certificate         | Host            | Thumbprint                                 | Current expiry |
| ------------------- | --------------- | ------------------------------------------ | -------------- |
| `earrr-app-managed` | `earrr.app`     | `B40DB9BA828FD345CD1A275A4C50208CAD02C596` | April 3, 2027  |
| `earrr-www-managed` | `www.earrr.app` | `FB6C627B64503F2656532984679E46D56B9A3B35` | April 3, 2027  |

Azure manages renewal. Before changing the plan or moving hosting, refresh the
ingress IP and check DNS/certificate state rather than assuming these values:

```powershell
az webapp config hostname get-external-ip -g rg-earrr-prod --webapp-name earrr-prod-54cd1f78
az webapp config hostname list -g rg-earrr-prod --webapp-name earrr-prod-54cd1f78
gddy dns list earrr.app
```

## Runtime credentials

| Runtime variable            | Key Vault secret            |
| --------------------------- | --------------------------- |
| `AZURE_OPENAI_API_KEY`      | `azure-openai-api-key`      |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase-service-role-key` |
| `LEARNING_SAVE_KEY`         | `learning-save-key`         |

All references were checked as **Resolved**, and initial secret values were
byte-verified without logging them. The app's system identity has vault-scoped
**Key Vault Secrets User**. The operator has vault-scoped Secrets Officer.

**Never rotate `LEARNING_SAVE_KEY` as a deployment step.** Its exact existing value
is required to decrypt saved guest/account learning and chat.

Public endpoint/model names, Supabase URL/publishable key, origins and hosting
flags are App Service settings. Resend SMTP credentials are held in Supabase
Auth's provider settings, not in the web app. GoDaddy and Supabase management
credentials stay in the operator's CLI/keyring. The unused optional Luna
credentials remain in the private local `.env` and are not shipped.

`.env`, data, test results, generated artifacts and private session files are
ignored by Git and packaging. No private credential was found in published source
or browser bundles. Do not paste secret values into this document or workflow.

Authorized private runtime synchronization:

```powershell
node deploy\sync-runtime.mjs
node deploy\verify.mjs --infrastructure
```

The synchronizer loads `.env` internally, uses temporary private secret files,
suppresses secret output, checks stored values and cleans its own files. It does
not rewrite `.env`, replace the save key, or deploy management credentials.

## Supabase and email

- Project: `smxezziivohyldytykzv`; account learning/chat is encrypted and owner-scoped.
- Site URL: `https://earrr.app`; public callback is `/auth/callback`.
- Existing localhost callback entries remain for authorized local development.
- Email confirmation stays required; signup/password recovery use **six-digit
  codes**, not automatic confirmation.
- SMTP: `smtp.resend.com`, port **465**, username `resend`.
- Sender: **Earrr <hello@earrr.app>**, explicitly selected from verified
  `earrr.app`, never the older unrelated verified domain.
- Auth email rate limit: 30/hour.
- Templates: `supabase/templates/confirmation.html` and `recovery.html`.
- Email logo: public `earrr-brand/wordmark.png` in the project's Supabase Storage.

Real Supabase-to-Resend SMTP confirmation/recovery emails were inspected, their
actually delivered codes verified through Auth, and rendered at 640px/390px with
the real logo. Recipient was **Resend's simulated delivery address**, not a human
inbox. Message IDs: confirmation `01a0ff84-192f-7774-a04b-6451015c77f8`,
recovery `01a0ff84-297c-770d-9275-8b825acad614`. Test user was removed without
touching real accounts. These checks establish transport/template/code behavior,
not personal-inbox or spam-folder placement.

```powershell
node scripts\configure-supabase.mjs --apply-email --domain earrr.app --sender hello@earrr.app --origin https://earrr.app
node scripts\verify-email.mjs
```

Never use the helper without an explicit verified domain. Management scripts and
their privileges are excluded from production artifacts.

## GitHub CI/CD and releases

PR/main CI on Ubuntu runs locked installation, typecheck, formatting, Vitest,
deployment guards, production build and Chromium UI checks. Credentialed native
voice/provider/SMTP fixtures are operator checks, not PR jobs.

Main delivery installs production dependencies on Linux and creates one immutable
ZIP plus checksum/metadata. It deploys only that checked artifact, validates the
exact release/commit on the owned Azure default host, then creates the Git tag and
GitHub release:

```text
YYYYMMDDTHHMMSSZ-<sha8>
```

Timestamps are UTC. Package semver is not used for release names. Tags are immutable;
failed deployments do not publish successful releases. Main delivery is serialized,
tag creation does not recursively trigger another delivery.

Azure login uses ARM-managed identity federation, not a password/publish profile:

| Setting                  | Value                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| Managed identity         | `id-earrr-github-prod`                                              |
| Client ID                | `f0cc424f-2008-4d41-9e08-c5f3d1e3ef4f`                              |
| Issuer                   | `https://token.actions.githubusercontent.com`                       |
| Actual immutable subject | `repo:jiin-kim109@57239105/Earrr@1402500494:environment:production` |
| Audience                 | `api://AzureADTokenExchange`                                        |
| Deploy role              | Website Contributor on only this web app                            |

GitHub now includes numeric owner/repository IDs in this new repository's OIDC
subject. Azure's trust was updated to the observed assertion, rather than reverting
GitHub to legacy naming.

Environment `production` permits only `main`, without a branch-protection prerequisite.
Non-secret `AZURE_*` variables identify the tenant/subscription/group/web app;
`AZURE_DEPLOYMENT_AUTHORIZED=true` is a repository gate. Target-bound authorization
is in `config.json`. GitHub/Azure identities have no subscription Owner or vault
data-plane role. External actions use verified immutable commit SHAs.

```powershell
gh run list --repo jiin-kim109/Earrr --workflow ci.yml --limit 5
gh run watch <run-id> --repo jiin-kim109/Earrr --exit-status
gh release list --repo jiin-kim109/Earrr
```

## Verification and recovery

### Raw event logging

`supabase/migrations/20261004001000_earrr_raw_events.sql` creates one
service-only `earrr_events` table and an hourly `pg_cron` cleanup of events
received more than 30 days ago. It was applied to the Earrr Supabase project on
October 4, 2026 UTC and recorded in migration history. RLS is enabled; anonymous
reads and authenticated-client writes are denied, while service-role writes are
allowed. No additional analytics tables or pipelines are created.
The earlier account schema already existed before CLI migration history was
tracked; its tables, profile trigger, save RPC and RLS were checked before
reconciling the existing migration record.

Both frontend and backend use the same compact interface:

```ts
Log.event('training.start_clicked', { lessonId: 'triads' });
Log.event('audio.device_unavailable', { kind: 'speaker' }, { level: 'warn' });
Log.error('request.failed', error, { operation: 'grading' });
```

Import `Log` from `frontend/lib/log.ts` in browser code or
`server/services/log.service.ts` on the server. Context is automatic: timestamps,
event/level/source, learning `session_id`, page-launch `visit_id`, anonymous
browser `visitor_id`, verified `actor_id`, HTTP `request_id`, environment and
release. `message` remains JSON for event-specific dimensions. Event names use
lowercase dot-separated words.

Browser events go through `/api/logs`; clients cannot choose server identities or
read the table. Session ownership is verified and service-role inserts ignore
duplicate event IDs. Keep credentials, personal identifiers, raw chat and audio
out of messages. Known sensitive fields, emails, URL queries and configured server
secrets are redacted as an additional safeguard, not permission to log user content.

Messages are limited to 8 KB/eight nesting levels. Browser batches contain at
most five events, server batches twenty; queues are memory-only and bounded.
Logging never delays grading or retries forever. Failed delivery is diagnostic
output, so events during complete network loss are not guaranteed. Distinguish
client/server events and use `callId`, question/attempt IDs when deduplicating
retried business operations. Developer traffic is marked separately from production.

Build into an isolated output instead of replacing a running local server's `dist`:

```powershell
npm run deploy:build -- --output test-results\azure-proof
$env:EARRR_E2E_SERVER_ENTRY = (Resolve-Path test-results\azure-proof\dist\server\main.js).Path
$env:EARRR_E2E_PORT = '3317'
npx playwright test
```

Packaging runs only in a clean committed Linux checkout:

```bash
npm ci --no-audit --no-fund
npm run build
npm run deploy:package -- --commit "$(git rev-parse HEAD)" --output /tmp/earrr-artifact
```

An authorized operator can recover an exact tested Linux artifact:

```powershell
gh run download <run-id> --repo jiin-kim109/Earrr --name earrr-production-<run-id>-<attempt> --dir test-results\deployment-recovery
npm run deploy:azure -- --artifact test-results\deployment-recovery\app.zip --metadata test-results\deployment-recovery\release.json --publish-release
```

Do not use a previously successful release identifier for a fresh deploy. Rollback
uses a newly checked artifact and date/hash release; B1 has no paid staging slot.
Full resource/principal/role IDs are in `config.json`, actual hosting properties in
`app-service.json`, and public release data in `/api/health`. Avoid dumping complete
app settings or retrieving vault plaintext for routine verification.
