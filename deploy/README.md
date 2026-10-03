# Earrr hosting operations - approved current subscription

**The user explicitly approved production deployment in subscription `54cd1f78-ae06-4388-9e52-15b452f21c10` on October 3, 2026 UTC.** The subscription is still named **Visual Studio Enterprise Subscription**. The earlier subscription guidance was acknowledged by the user; it is not retained as a technical deployment blocker. This records user authorization, not an independent licensing or billing-offer reclassification.

The existing one-worker B1 resources, identities and secret locations are reused. No spending limit, billing plan or active subscription was changed, and no billing upgrade is authorized. The repository variable `AZURE_DEPLOYMENT_AUTHORIZED` is **true**. `config.json` binds explicit production approval and acknowledgement to this exact subscription; changing only the variable cannot bypass the target/approval checks.

The initial application ZIP, release and actual GitHub OIDC exchange have not run. The remaining initial-deployment prerequisite is the parent-owned commit/push and resulting Linux CI artifact, not a subscription-eligibility hold. The default Azure root returned **HTTP 503** at initial verification because application code had not been deployed; resource `Running` is not an application-health claim. The parent alone inspects `duri-infra` read-only; none of its private config or secrets are copied into Earrr.

## Provisioned target

| Item                   | Actual value                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| Repository             | `jiin-kim109/Earrr` (public)                                       |
| Subscription           | `54cd1f78-ae06-4388-9e52-15b452f21c10`                             |
| Tenant                 | `04e8677e-c989-47b9-8619-d83d5a5f6c67`                             |
| Resource group         | `rg-earrr-prod` (westus2 resource-group metadata)                  |
| App Service plan       | `asp-earrr-prod`, Linux B1, one worker, westus3                    |
| App Service            | `earrr-prod-54cd1f78`                                              |
| Default validation URL | `https://earrr-prod-54cd1f78.azurewebsites.net`                    |
| Canonical origin       | `https://earrr.app`                                                |
| Current inbound IP     | `20.40.24.37`                                                      |
| Domain verification ID | `F3713716E4BE315BD546834F1D151FFE924E13F54CFFCCC6E3F79F98486249CD` |
| Runtime/startup        | `NODE\|22-lts`; `node dist/server/main.js`                         |
| Key Vault              | `kv-earrr-prod-54cd1f78`, Standard/RBAC, westus2                   |
| GitHub environment     | `production`, selected branch policy allows only `main`            |

All complete ARM resource IDs, principal IDs and actual role-assignment IDs are in `config.json`. No active desktop subscription or signed-in account was changed. The table records the existing user-approved target; it does not assert independent licensing verification.

Azure rejected westus2 B1 creation because its B1 VM quota was **0**. The supported westus3 fallback succeeded with the same one-instance B1 budget. The vault and user-assigned deployment identity remain in westus2; no second plan was created.

The Azure Retail Prices API was checked on **October 3, 2026 UTC**: westus3 **Azure App Service Basic Plan - Linux / B1 / Consumption** is **USD 0.017 per hour**, or **USD 12.41 at 730 hours**. Standard Key Vault operations in westus2 are **USD 0.03 per 10,000 operations**. These are retail estimates, not invoice guarantees; taxes, bandwidth, existing Supabase, Azure OpenAI usage and domain/mail charges are separate. A stopped web app does not stop plan billing.

Retail pricing and another running application are not independent licensing verification. The user acknowledged the earlier offer guidance and authorized this exact target. Do not remove a spending limit, upgrade billing or switch subscriptions: none of those operations is authorized or required by this deployment path.

There is no ACR, custom Docker image, Container Apps, autoscaling, extra paid database, storage account, Application Insights or staging slot. Keep the plan at one B1 worker. Account data remains in the existing Supabase project; guest saves remain encrypted in the browser. Execution workspaces are transient, not a new durable database.

## Hosting and access

The app is HTTPS-only, Always On, TLS 1.2 minimum for both site and SCM, with FTP and both FTP/SCM basic publishing authentication disabled. Azure CLI deployment uses Microsoft Entra authentication, not a publish profile. `app-service.json` records the actual site configuration.

Production listens on `0.0.0.0` and the platform `PORT` (`8080` is explicitly configured). Normal local Windows startup remains loopback-only, including when a canonical `PUBLIC_ORIGIN` is configured locally.

Only exact config-owned origins are enabled in production:

```text
https://earrr.app
https://www.earrr.app
https://earrr-prod-54cd1f78.azurewebsites.net
```

Hostnames must match that configuration, and an Origin header must match the actual request host, not merely another approved domain. Forwarded host/protocol/origin headers cannot expand trust. Mutations still require `x-earrr-client: 1`. `www` is explicitly supported as an owned hostname, while `PUBLIC_ORIGIN` and HTML canonical metadata remain `https://earrr.app`. There is no forced redirect onto the root certificate during first-deploy validation. Domain binding, DNS, certificate/redirect decisions and mail remain parent-owned.

The default hostname is the health-gate endpoint for the approved initial deployment. The parent owns DNS/binding and can refresh the IP before making its separately authorized changes:

```powershell
az webapp config hostname get-external-ip --resource-group rg-earrr-prod --webapp-name earrr-prod-54cd1f78 --subscription 54cd1f78-ae06-4388-9e52-15b452f21c10 --output json
```

No DNS, SMTP, Supabase management configuration or user progress was changed by this setup.

## Runtime secrets

| App setting                 | Key Vault secret            | Initial verification              |
| --------------------------- | --------------------------- | --------------------------------- |
| `AZURE_OPENAI_API_KEY`      | `azure-openai-api-key`      | Resolved                          |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase-service-role-key` | Resolved                          |
| `LEARNING_SAVE_KEY`         | `learning-save-key`         | Resolved; byte-for-byte preserved |

The App Service system identity, `046049dc-591c-4fee-a958-0b6780767250`, has **Key Vault Secrets User** on only the new vault. App settings contain versionless Key Vault references, not plaintext copies. The signed-in operator has **Key Vault Secrets Officer** scoped only to this vault for the authorized transfer/verification.

**Never rotate or replace `LEARNING_SAVE_KEY` as a routine deployment step.** Its exact existing value is required to decrypt existing guest and account saves. Keep the private original backup. The initial transfer compared each retrieved secret byte-for-byte without printing it.

Public settings are the existing Azure OpenAI endpoint/deployment names, Supabase URL/publishable key, Google-enabled flag, canonical/allowed origins and hosting flags. `DATABASE_URL`, Resend, GoDaddy, Supabase management credentials and the unused summary key are not uploaded.

To repeat an explicitly authorized runtime synchronization from the private operator `.env`:

```powershell
node deploy\sync-runtime.mjs
```

This script loads `.env` internally with Node's dotenv support, disregards stale shell overrides for the runtime allowlist, uses user-private temporary secret files, suppresses Azure secret output, verifies exact stored values and removes those named files/directories. It never edits `.env`. Do not replace this with commands that print secrets or put their raw values in command arguments.

After an authorized secret update, force reference resolution and inspect only non-secret status:

```powershell
az rest --method post --url "https://management.azure.com/subscriptions/54cd1f78-ae06-4388-9e52-15b452f21c10/resourceGroups/rg-earrr-prod/providers/Microsoft.Web/sites/earrr-prod-54cd1f78/config/configreferences/appsettings/refresh?api-version=2022-03-01" --subscription 54cd1f78-ae06-4388-9e52-15b452f21c10 --output none
node deploy\verify.mjs --infrastructure
```

## GitHub OIDC and permissions

The ARM-created user-assigned identity is `id-earrr-github-prod`:

| Property             | Value                                            |
| -------------------- | ------------------------------------------------ |
| Client ID            | `f0cc424f-2008-4d41-9e08-c5f3d1e3ef4f`           |
| Principal ID         | `8b2b9d3d-247f-4433-87c5-0810c48ea611`           |
| Federated credential | `github-production`                              |
| Issuer               | `https://token.actions.githubusercontent.com`    |
| Subject              | `repo:jiin-kim109/Earrr:environment:production`  |
| Audience             | `api://AzureADTokenExchange`                     |
| Deploy role          | Website Contributor, scoped to this web app only |

The deploy identity has no subscription Owner assignment, plan-write permission or Key Vault data-plane role. No Entra application registration, Azure password, publish-profile secret or GitHub Packages privilege is required.

These **non-secret environment variables** were created under `production`, not as secrets:

| Variable                 | Value                                           |
| ------------------------ | ----------------------------------------------- |
| `AZURE_CLIENT_ID`        | `f0cc424f-2008-4d41-9e08-c5f3d1e3ef4f`          |
| `AZURE_TENANT_ID`        | `04e8677e-c989-47b9-8619-d83d5a5f6c67`          |
| `AZURE_SUBSCRIPTION_ID`  | `54cd1f78-ae06-4388-9e52-15b452f21c10`          |
| `AZURE_RESOURCE_GROUP`   | `rg-earrr-prod`                                 |
| `AZURE_WEBAPP_NAME`      | `earrr-prod-54cd1f78`                           |
| `AZURE_WEBAPP_URL`       | `https://earrr-prod-54cd1f78.azurewebsites.net` |
| `AZURE_DEFAULT_HOSTNAME` | `earrr-prod-54cd1f78.azurewebsites.net`         |
| `AZURE_KEY_VAULT_NAME`   | `kv-earrr-prod-54cd1f78`                        |
| `AZURE_LOCATION`         | `westus3`                                       |

The `main` branch policy was created with ID `61808004`. Both repository and environment Actions secret counts were zero at initial verification. ARM federation/RBAC exist, but no actual GitHub OIDC exchange has run. The repository-level non-secret variable `AZURE_DEPLOYMENT_AUTHORIZED=true` enables the guarded deploy/release path after the final source is committed and CI succeeds.

The environment uses the explicit selected-branch policy `main`, with `custom_branch_policies: true` and `protected_branches: false`; there is no unconfigured protected-branch prerequisite. Branch permission is not deployment authorization or subscription eligibility.

## Initial delivery and parent integration

The parent owns Git initialization, commits, pushes, root business documentation and screenshots. Git is initialized on `main`; at approval-time inspection it had no HEAD commit and the GitHub repository was still empty. Before committing, restage the final owned delivery files rather than relying on an earlier staging snapshot:

```powershell
git add server\config\environment.ts server\middleware.ts server\app.ts server\main.ts tests\production-hosting.test.ts package.json playwright.config.ts .env.example deploy .github\workflows
```

Any source commit/push remains parent-owned. Do not add `.env`, `data`, `node_modules`, `dist`, `test-results` or private session artifacts. The approved config and true repository gate permit the hosted deployment only for the explicitly selected target.

A final `main` push runs CI in `.github\workflows\ci.yml` and can then deploy/release through the approved gate. The following allow an explicit subsequent run and inspection:

```powershell
gh workflow run ci.yml --repo jiin-kim109/Earrr --ref main
gh run list --repo jiin-kim109/Earrr --workflow ci.yml --limit 5
gh run watch <run-id> --repo jiin-kim109/Earrr --exit-status
```

The workflow checks out the exact source commit, uses Ubuntu 24.04 and Node 22.x, and runs `npm ci`, typecheck, formatting, Vitest, deployment-guard tests, the production build and Playwright Chromium UI checks. It does not run credentialed native voice, auth-provider management or SMTP fixtures.

Successful CI on the owned repository's `main` can install runtime dependencies **on Linux** into an allowlisted staging directory and create an immutable `app.zip` plus `release.json` for authoring. Creating a build artifact does not authorize publication. The ZIP contains only optimized `dist/client`, `dist/server`, `dist/shared`, `dist/prompts`, runtime npm dependencies and the two package manifests. Source maps, `.env`, user data, tests/results and operator/management scripts are not shipped. Packaging requires the exact checked-out commit and committed runtime/build/test/workflow inputs; Windows packaging is deliberately rejected.

The entire repository-level `deploy` and `scripts` directories are operator-only and excluded from the application ZIP, including future provider-management helpers added under `deploy` and the parent-owned `scripts/configure-supabase.mjs`. Unexpected `dist/deploy` or `dist/scripts` entries are also excluded during copying and rejected if introduced into the package by a future packaging change. The runtime manifest exposes only `start`, not provider-management commands. GoDaddy authentication/DNS and exact `earrr.app` SMTP configuration remain parent-owned; neither the app nor production startup depends on those helpers.

The deploy job is conditional on the repository authorization gate. It runs `authorize.mjs` **before Azure login**, requiring explicit user approval bound to the exact target subscription and purpose (`production` or `dev-test-demo`). If production eligibility was not independently verified, production approval must explicitly acknowledge the subscription guidance; that acknowledgement is now recorded. Local deployment and release entry points enforce the same target-bound approval. Only the approved deploy job receives `id-token: write` and performs OIDC, checksum, deployment and health checks.

All deployment and pre-release HTTP checks target only the owned Azure default URL, `https://earrr-prod-54cd1f78.azurewebsites.net`; they do not require `earrr.app` DNS or its certificate to be ready. The canonical origin is checked as HTML metadata, not requested as a health endpoint. Validation does not follow HTTP redirects, so a redirect cannot silently move the gate onto an unready custom domain. Keep the Azure default validation endpoints directly accessible while the parent completes DNS/TLS.

Only after an authorized deployment passes verification does the separately gated release job get `contents: write` and create the Git tag/release:

```text
YYYYMMDDTHHMMSSZ-<sha8>
```

The UTC timestamp is assigned when the immutable checked artifact is packaged; it is embedded in `dist/release.json` and the application health response. `package.json` version is not used for releases. Existing successful tags cannot be redeployed under the same identifier; run fresh CI for another successful deployment. Failed deployment/verification does not create a successful release.

Main deployments are serialized without cancelling an in-progress deploy. PR CI can be cancelled by a newer PR run. Tag creation does not retrigger the main-only push workflow. External actions are pinned to verified upstream commit SHAs; current checked versions are checkout 7.0.1, setup-node 7.0.0, upload-artifact 7.0.1, download-artifact 8.0.1 and azure/login 3.1.0.

**Remaining initial-deployment prerequisite:** a parent commit/push containing these final approval and workflow files, followed by the Linux CI artifact and its actual OIDC/deploy/health/release run. The target is approved; no capacity or permission error is currently blocking the existing westus3 B1 resources. The historic westus2 B1 quota-0 error was already resolved by the supported westus3 fallback without a higher-priced SKU.

## Local verification and manual recovery

Build without overwriting the existing port-3000 app's `dist`:

```powershell
npm run deploy:build -- --output test-results\new-azure-proof
$env:EARRR_E2E_SERVER_ENTRY = (Resolve-Path test-results\new-azure-proof\dist\server\main.js).Path
$env:EARRR_E2E_PORT = '3317'
npx playwright test
```

Choose a fresh empty output directory and an unused test port. The test server uses isolated in-memory legacy fixtures with Azure/Supabase credentials disabled; it does not mutate real cloud progress.

Manual packaging, if needed, must run in a clean **Linux** checkout of the committed source:

```bash
npm ci --no-audit --no-fund
npm run build
npm run deploy:package -- --commit "$(git rev-parse HEAD)" --output /tmp/earrr-new-artifact
```

The recovery procedure below applies to the explicitly approved target. Prefer the gated workflow, which also runs browser checks before packaging. An authorized Windows operator can recover an exact Linux artifact whose deployment failed before release:

```powershell
gh run download <run-id> --repo jiin-kim109/Earrr --name earrr-production-<run-id>-<run-attempt> --dir test-results\deployment-recovery
npm run deploy:azure -- --artifact test-results\deployment-recovery\app.zip --metadata test-results\deployment-recovery\release.json --publish-release
```

`--publish-release` first enforces the same explicit subscription/purpose approval, then rechecks the deployed application before publishing. Any dev/test demo must be labeled as such, never as production. Do not use a previously successful release artifact to bypass the fresh-release rule. Rollback also requires target-bound approval and a new checked artifact/date-hash release. There is no B1 staging-slot swap.

After a deployment, the following reads only public release data:

```powershell
Invoke-RestMethod https://earrr-prod-54cd1f78.azurewebsites.net/api/health
node deploy\verify.mjs --metadata test-results\deployment-recovery\release.json
```

The second command requires the corresponding metadata file and checks both ARM security/secret-reference status and the deployed app. Do not print entire app-setting values or retrieve plaintext vault secrets for routine health checks.

## Primary references

- [Visual Studio Azure-credit production restrictions and service limitations](https://learn.microsoft.com/en-us/visualstudio/subscriptions/faq/subscriber/azure/)
- [App Service Node runtime and PORT](https://learn.microsoft.com/en-us/azure/app-service/configure-language-nodejs)
- [Run from an immutable ZIP package](https://learn.microsoft.com/en-us/azure/app-service/deploy-run-package)
- [Deployment authentication without basic publishing credentials](https://learn.microsoft.com/en-us/azure/app-service/deploy-authentication-types)
- [Key Vault references and managed identities](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)
- [ARM-managed identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-user-assigned-managed-identity)
- [Website Contributor permissions](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/web-and-mobile#website-contributor)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
