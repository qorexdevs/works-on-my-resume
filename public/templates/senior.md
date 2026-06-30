---
name: Marcus Halberg
role: Staff Software Engineer — Infrastructure
location: Stockholm, Sweden
email: marcus.halberg@example.com
phone: +46 70 555 0142
links:
  - label: GitHub
    url: https://github.com/marcus-halberg-example
  - label: LinkedIn
    url: https://www.linkedin.com/in/marcus-halberg-example
  - label: Website
    url: https://marcus-halberg.example.com
---

## Summary

Staff infrastructure engineer with twelve years across platform, storage,
and developer tooling. Specialty: turning fragile, hand-operated systems
into boring, well-instrumented platforms that other teams can build on
without a platform ticket. Comfortable as a senior individual contributor
and as a technical lead across organisational boundaries.

## Selected Impact

- **Replaced the company's bespoke deploy pipeline with a progressive-delivery
  platform.** Adoption hit 31 of 33 backend teams in eight months;
  change-failure rate dropped by 46% in the first two quarters.
- **Authored the storage-tier RFC** that consolidated five regional Postgres
  fleets into a tenant-routed multi-region setup; cut steady-state cost by
  **\$1.4M annually** while improving cross-region read latency.
- **Wrote the golden-path service template** now used for every new backend
  service across the company; observability, security scanning, and a
  default CI workflow ship turned on.
- **Led the company-wide incident-response overhaul.** Mean time to mitigation
  dropped from 47 minutes to 18 across a full year of SEV-2+ incidents, and
  the postmortem program now publishes monthly.
- **Mentored five engineers through Senior promotion** and two through Staff;
  three now run their own platform teams.

## Experience

### Staff Software Engineer — Tessera Logistics

_Apr 2022 – Present · Stockholm (hybrid)_

Technical lead for the platform organisation, ~24 engineers across three
teams (build, deploy, observability).

- Drove the multi-region storage RFC end to end: design review, migration
  plan, capacity model, and the cutover playbook.
- Built the org-wide on-call review program; every incident at SEV-2 or
  higher now produces a published postmortem within five working days.
- Partnered with security to ship a default-on supply-chain attestation
  pipeline used by every production build.
- Represented engineering on the company's reliability council; chaired
  the architecture review board for the last six quarters.
- Tech-led the migration off a legacy message bus across **140 services**
  with no customer-facing downtime over a six-month rollout.

### Senior Software Engineer — Tessera Logistics

_Jun 2019 – Mar 2022 · Stockholm_

- Built the progressive-delivery platform now used by every backend team.
- Designed and shipped the canary-analysis service that gates every
  promotion to production on real metrics.
- Ran the platform on-call rotation through the company's first three
  Black Friday peaks; the platform itself contributed zero customer-facing
  incidents in that window.
- Wrote the internal "How we ship" handbook still used during onboarding.

### Senior Software Engineer — Pelagic Software

_Feb 2017 – May 2019 · Gothenburg, Sweden_

- Led a four-engineer team building the multi-tenant deployment service
  for a B2B SaaS platform serving **600+ enterprise tenants**.
- Migrated the product off a shared monolith database to per-tenant
  schemas; eliminated a class of noisy-neighbour incidents that had
  caused six outages the prior year.
- Designed the SLO program for the API platform; SLOs were adopted by
  every engineering team within two quarters.

### Software Engineer — Pelagic Software

_Aug 2014 – Jan 2017 · Gothenburg, Sweden_

- Shipped the second-generation public API, including OAuth-based auth and
  rate-limit accounting consumed by 40+ partner integrations.
- Owned the deploy + build-tooling rotation through a migration from
  Jenkins to GitLab CI; promoted to Senior at the end of year two.

### Earlier roles

_2013 – 2014_: Software engineer at **Aurora Health Systems** (Linköping)
on a clinical-imaging desktop product (C++, Qt).

## Selected Projects and Talks

- **`relay-cache`** - open-source remote build cache used internally at
  Tessera and externally by a handful of consultancies.
  [github.com/marcus-halberg-example/relay-cache](https://github.com/marcus-halberg-example/relay-cache)
- **"Boring deploys at logistics scale"** - talk at NordicConf 2024 on
  the progressive-delivery rollout at Tessera.
- **"The on-call rotation is a product"** - guest essay on the SREcon
  blog, 2023.

## Skills

- **Languages:** Go, Rust, TypeScript, Python, Bash
- **Platforms:** Kubernetes, Nomad, AWS, GCP, Cloudflare
- **Data:** PostgreSQL, ClickHouse, Kafka, Redis
- **Infrastructure:** Terraform, Pulumi, Crossplane, OpenTelemetry
- **Practices:** RFC-driven design, blameless postmortems, SLO programs,
  staff-engineer-as-glue across team boundaries

## Education

### M.Sc. Computer Science — KTH Royal Institute of Technology

_2011 – 2013 · Stockholm, Sweden_

### B.Sc. Computer Science — Lund University

_2008 – 2011 · Lund, Sweden_

---

_References available on request._
