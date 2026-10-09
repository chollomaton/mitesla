# TELEMETRY INTEGRITY — remote certification

Status: `TELEMETRY_INTEGRITY_REMOTE_CERTIFIED` (2026-10-09).
Certified runtime commit: `e93d2d5ab85951009321b221072de464bbc04f39`. Main remained `e11fa8377203e2bf6cd03e63fe9abd7265aa13f6`. No runtime code changed during remote certification.

## Result

80/80 remote assertions PASS. Fresh D1 migrations 0001–0009, exact schema/index comparison, foreign keys and ledger PASS. HMAC missing secret 503, missing/wrong signature 401, correct signature 200 and malformed JSON 400 PASS. ADMIN_TOKEN and browser sessions do not bypass telemetry HMAC. VIN allowlist, transport replay, exact retries, concurrent conflicting dedupe keys and out-of-order snapshot protection PASS.

Trips and charges each pass golden closure, exactly-once consolidation, manual override/revision/tombstone protection, alternate-ID rejection, interrupted closure recovery and late start recovery after a pre-RAW failure. Remote measured charge zero remains zero; absent power and trip energy remain null. Canonical revisions are not an upstream telemetry field: same-revision identical/different and decreasing-revision cases execute the actual production reconciliation function through an authenticated canary-only harness endpoint.

Remote BACKUP_BACKEND export/verify/restore/equivalence PASS against two additional fresh synthetic D1 databases; 0009 fingerprints are included. Browser sessions, nonce/RAW and secrets stay excluded. Eight-migration backups fail closed before remote writes. Production restore/export hard deny PASS.

## Isolated resources, all deleted

- Telemetry D1: `mitesla-telemetry-cert-20261009123134` / `95ed0991-e0c2-44cf-a1e5-e4763fd8385a`.
- Canary: `mi-tesla-telemetry-canary-20261009123134`; URL `https://mi-tesla-telemetry-canary-20261009123134.carlosgconde.workers.dev` (deleted).
- Canary deployment: `f949a5ae-5296-4a0a-ba2b-63670383a7a1`; version `bad7fd33-4144-44c1-8d32-ceb77baffd62`.
- Backup source: `mitesla-backup-cert-source-20261009123329-76024871` / `ae39c2a8-5c78-427d-ae00-f7049837eaa4` (deleted).
- Backup target: `mitesla-backup-cert-target-20261009123412-b36f8264` / `6bdc56f7-9d31-4749-9b43-99b02138ec74` (deleted).

All 14 resources from the final pass and earlier attempts returned HTTP 404 on authenticated metadata reads after cleanup. Initial attempts were cleaned after a Free-plan CPU configuration rejection, deployment/secret propagation responses and a test fixture missing its initial AC counter. The successful pass waits for propagation and provides measured initial/final counters; no runtime fix was needed.

## Production, credentials and scope

Production deployment `7ceae60d-0481-48ed-b076-7de12bb2c966`, version `deacebbc-b883-4da1-8c19-ca45130e8bb2` unchanged, with full deployment history equal before/after. Zero production D1 requests; zero production authority requests. Production D1 `98d74aae-e2f2-40d0-8c20-3349f08ada1f` is denied by the API wrapper. No Tesla call, production worker write, merge, route or custom domain change occurred. Free plan confirmed by Cloudflare; no paid plan or resource enabled.

OAuth was renewed interactively once with account:read, workers_scripts:write and d1:write, stored encrypted with macOS Keychain; no permanent API token was created. Synthetic canary secrets were random and removed with the worker. Wrangler unexpectedly persisted captured OAuth output in local debug logs; all nine affected logs were sanitized, and the reproducible harness disables credential-command disk logging. No credential values are in this report or Git.

Recovery uses separate HTTP requests plus remote D1 persistence. The canary-only wrapper injects one write failure before RAW or after canonical insertion; forced isolate eviction was not performed. The entry imports the exact branch runtime. No KV, production routes or real vehicle credentials are bound. Canary observability was disabled and no tail session started. Responses were checked against in-memory secrets and secret-field quarantine redaction passed. Retained runtime log retrieval was not performed; this certificate does not claim an audit of external Cloudflare security logs.

## Promotion preflight

The branch is ready for promotion preflight only. Before any separately authorized promotion, inspect production for duplicate telemetry openings that would reject 0009's unique indexes, assess backups and migration/configuration rollout, and revalidate authority and production bindings. Applying 0009 to production, merging and deploying remain pending. Real-Tesla validation is outside this certificate.

Machine-readable evidence: `REMOTE-CERTIFICATION.json`. Reproduction: set `MITESLA_REPO` to the checkout and `WRANGLER_JS` to the installed Wrangler entry point, then run `python3 tools/telemetry/certify_remote.py` from a separate scratch directory with valid OAuth. It creates synthetic remote resources and removes them. The harness never deploys production.
