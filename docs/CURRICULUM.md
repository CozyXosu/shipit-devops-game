# SHIP IT as a curriculum — what this game teaches vs. what a real DevOps job needs

The game covers the core loop of DevOps/platform/SRE work end to end: build it,
run it, break it, scale it, secure it, hand it over. Every mission's dock shows
an **In a real job** note naming the transferable skill and the real tools —
that note, plus the 📘 lessons on file-authoring missions, is the intended
learning layer. This document maps the whole curriculum and is honest about
what a simulator cannot teach you.

## The map

| Phase | Missions | Competency | Real-world tools |
|---|---|---|---|
| Build I: servers | m01–m05 | SSH/forensics, service debugging, Unix permissions, reverse proxy, DNS | OpenSSH, journalctl, nginx/Caddy/ALB, Route 53, dig |
| Build II: code→prod | m06–m11 | Git, branches/conflicts, secret hygiene, Docker, CI/CD, managed databases | GitHub Actions/GitLab CI, Docker, RDS/Cloud SQL |
| Build III: operate | m12–m15 | Monitoring & alerting, incident response, log management, rollback, query tuning | Prometheus, Grafana, PagerDuty, logrotate, EXPLAIN ANALYZE |
| Scale: platform | m16–m20 | HA & load balancing, staging + e2e + approvals, Terraform/IaC + drift, Kubernetes, backup/DR with RPO/RTO | ALB/NLB, Playwright, Terraform/OpenTofu, kubectl/EKS/GKE, pgBackRest |
| Operate & grow | m21–m24 | On-call & hiring, tech-debt management, progressive delivery (canary/blue-green), SLOs & error budgets | PagerDuty/Opsgenie, Argo Rollouts/Flagger, Google SRE workbook ch. 4–5 |
| Ecosystem | m25–m28 | Multi-cloud tradeoffs, migrations, product/platform packaging, FinOps | AWS/Azure/GCP, Cost Explorer/OpenCost/Infracost |
| Modes & content | m29–m32 | Declarative policy DSLs, blameless postmortems & MTTR, constraint drills (budget/SLO/DR), accessibility & i18n | Sentinel/OPA, postmortem culture, game days, WCAG |
| Trust (security) | m33–m36 | Secrets management & rotation, zero trust (mTLS, NetworkPolicy, non-root), supply chain (signing, SBOM, admission), compliance evidence | HashiCorp Vault/AWS Secrets Manager, Istio/Linkerd, Sigstore/cosign, Trivy, Kyverno, SOC 2/ISO 27001 |
| Platform endgame | m37–m40 | Internal developer platform & golden paths, ephemeral preview environments, distributed tracing & pooling, due diligence | Backstage, Vercel/Netlify previews, OpenTelemetry, Jaeger/Tempo, pgbouncer |

## How to actually learn from it

1. Play the mission yourself before touching hints. The hints are progressive
   on purpose — each one costs rating, which is the game's stand-in for "a
   senior had to spend time on you".
2. Read the 📘 lesson and the **In a real job** note even after you pass.
   The note is the part that transfers.
3. Type the files yourself on file-authoring missions even when the starter
   could be filled by copy-paste — the sim parses what you write, and the
   parsers complain like real tools do.
4. When a mission mentions a real tool you don't recognize, look up the real
   tool's docs for five minutes. The sim teaches the shape; the docs teach the
   product.

## What this game does NOT cover — the real gap list

A simulator has no room for these; each one is standard interview material
and day-to-day work. Learn them outside the game, roughly in this order:

1. **Programming & scripting.** The game's app is pre-written; real jobs
   assume you can read and write code. Bash + Python minimum, Go for
   Kubernetes-adjacent work.
2. **Caching & CDNs.** Redis/Memcached, cache invalidation, stampedes,
   CloudFront/Cloud CDN. Every "the site is slow" ticket lives here.
3. **Queues & streaming.** SQS/Kafka/RabbitMQ, retries, dead-letter queues,
   idempotent consumers. The backbone of any non-trivial architecture.
4. **Load testing & capacity planning.** k6/JMeter, finding the bottleneck
   before your customers do, sizing from headroom.
5. **Structured logging & log aggregation.** JSON logs, correlation IDs,
   Loki/ELK queries. The game only teaches rotation (m13).
6. **GitOps delivery.** ArgoCD/Flux: the cluster pulls from git, git is the
   only interface. The natural next step after m18/m19.
7. **Feature flags.** LaunchDarkly/Unleash: decoupling deploy from release —
   the other half of progressive delivery.
8. **Helm & manifest packaging.** Real clusters don't hand-write YAML like
   m19; they template it (Helm/Kustomize).
9. **Public TLS lifecycle.** cert-manager, Let's Encrypt, expiry alerting.
   The game teaches mTLS inside the mesh (m34), not the public front door.
10. **Serverless & event-driven.** Lambda/Cloud Functions, DynamoDB streams,
    and when not to use them.
11. **Rate limiting & WAF.** Per-client limits, bot protection, API gateways.
12. **SQL depth.** Window functions, join tuning, schema design under change —
    m11/m15 open the door; a real role walks through it.

## Canonical reading (what the industry actually references)

- *Google SRE Book* + *SRE Workbook* (free online) — m24/m30/m31 in print.
- *The Phoenix Project* — the org-politics half the sim compresses into m21/m22.
- *Terraform: Up & Running* — m18 with real providers.
- *Designing Data-Intensive Applications* — gaps 2, 3 and 12 in one book.
