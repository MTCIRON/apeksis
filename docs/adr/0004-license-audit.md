# ADR 0004: Package adapters, no vendored application code
Status: Accepted with release audit gate

Call official EMA, Antalia Mini and Faster-Whisper APIs via independently written adapters. Do not copy AGPL receptionist apps, the earlier application, Hitabet or upstream API source. Selected weights/package artifacts must be pinned, hashed during provisioning and audited before distribution; include licenses and notices with images. Antalia 1 weights are excluded. See upstream-audit.md and THIRD_PARTY_NOTICES.md for primary sources. Container SBOM, full transitive license review and vulnerability scans remain release gates, not claimed complete.
