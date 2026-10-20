# Software Bill of Materials (SBOM)

This document explains how to retrieve and use the Software Bill of Materials (SBOM) for `ourdao-backend` Docker images.

## What is an SBOM?

A Software Bill of Materials (SBOM) is a comprehensive inventory of all software components, dependencies, and packages included in an application or container image. For `ourdao-backend`, the SBOM includes:

- **Base image contents** (Alpine Linux packages from `node:22-alpine`)
- **npm dependencies** (both direct and transitive)
- **Application code** (the `ourdao-backend` package itself)

SBOMs are essential for:
- **Vulnerability management**: Quickly determine if a CVE affects your deployed image
- **License compliance**: Know exactly what licenses are present in the full software stack
- **Supply chain security**: Track all components in your deployment
- **Audit trails**: Document what was deployed at any point in time

## SBOM Generation

Every Docker image build in CI automatically generates an SBOM in **SPDX JSON format**. The SBOM is:

1. **Generated during build** by Docker Buildx using the `--sbom` flag (issue #219)
2. **Covers the full stack**: base image OS packages, npm dependencies, and application code
3. **Attached to the image** as metadata (can be inspected without running the container)
4. **Uploaded as a CI artifact** for easy retrieval

## Retrieving the SBOM

### Option 1: GitHub Actions Artifact (Recommended)

For any commit built by CI, download the SBOM from the GitHub Actions run:

1. Go to the [Actions tab](https://github.com/ourdao/ourdao-backend/actions) in this repository
2. Find the CI run for the commit you deployed (commit SHA is in the run title)
3. Scroll to the "Artifacts" section at the bottom of the run
4. Download `sbom-<commit-sha>.json`

Artifacts are retained for **90 days** from the build date.

### Option 2: Inspect the Image Directly

If you have the image locally or in a registry, extract the SBOM using Docker Buildx:

```bash
# Inspect a local image
docker buildx imagetools inspect ourdao-backend:latest --format '{{json .SBOM}}' > sbom.json

# Inspect an image in a registry (when images are published)
docker buildx imagetools inspect registry.example.com/ourdao-backend:v1.2.3 --format '{{json .SBOM}}' > sbom.json
```

The SBOM is embedded in the image's attestation metadata, so this works for any image built with SBOM generation enabled (all images built after issue #219 landed).

### Option 3: Generate Locally

Rebuild the image locally with SBOM generation:

```bash
docker buildx build --sbom=true --output type=image,name=ourdao-backend:local .
docker buildx imagetools inspect ourdao-backend:local --format '{{json .SBOM}}' > sbom.json
```

This produces an SBOM identical to what CI generates for the same commit (assuming the same base image digest and `package-lock.json`).

## SBOM Format

The SBOM is in **SPDX 2.3 JSON** format, a widely-supported standard for software composition analysis tools. Key fields include:

- `spdxVersion`: SPDX spec version (currently `"SPDX-2.3"`)
- `creationInfo`: When and how the SBOM was created
- `packages`: Array of every software package in the image
  - `name`: Package name
  - `versionInfo`: Version number
  - `licenseConcluded`: License identifier (SPDX format)
  - `supplier`: Package origin
  - `externalRefs`: Links to package managers (npm, apk) and security databases

## Using the SBOM

### Vulnerability Scanning

Feed the SBOM to a vulnerability scanner to check for known CVEs:

```bash
# Using Grype (https://github.com/anchore/grype)
grype sbom:sbom.json

# Using Trivy (https://github.com/aquasecurity/trivy)
trivy sbom sbom.json

# Using Syft + Grype pipeline
syft packages sbom.json -o json | grype
```

These tools cross-reference the SBOM's package list against public vulnerability databases (CVE, GitHub Security Advisories, etc.) and report any matches.

### License Auditing

Extract all licenses from the SBOM:

```bash
jq '.packages[] | select(.licenseConcluded != "NOASSERTION") | {name: .name, license: .licenseConcluded}' sbom.json
```

This lists every package's declared license. Compare this against your organization's license policy.

### Answering "Does This Image Contain X?"

Check if a specific package or version is present:

```bash
# Check for a specific npm package
jq '.packages[] | select(.name == "express")' sbom.json

# Check for a specific Alpine package
jq '.packages[] | select(.name == "openssl")' sbom.json

# List all packages matching a pattern
jq '.packages[] | select(.name | contains("ssl"))' sbom.json
```

This is useful when a security advisory names a specific package and you need to know if any of your deployed images include it.

## Base Image Pinning

The Dockerfile pins the base image (`node:22-alpine`) by **digest** rather than tag (issue #219):

```dockerfile
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
```

**Why digest pinning matters for SBOMs:**

- A tag like `node:22-alpine` can point to different images over time (new Alpine packages, new Node.js patch release)
- A digest (`sha256:...`) is immutable—it always refers to the exact same bytes
- The SBOM describes the packages in a specific image; pinning by digest ensures the SBOM matches the deployed image exactly

**To update the base image:**

1. Pull the latest `node:22-alpine`: `docker pull node:22-alpine`
2. Get its digest: `docker image inspect node:22-alpine --format '{{.RepoDigests}}'`
3. Update the `FROM` lines in the Dockerfile with the new digest
4. Rebuild—the SBOM will reflect the new base image contents

Without digest pinning, an SBOM generated yesterday might not match the image built today (same tag, different contents). With digest pinning, the SBOM is reproducible.

## Deployed Image SBOM Lookup

To find the SBOM for a currently running deployment:

1. **Get the deployed image's commit SHA** from `GET /version` (the `commit` field)
2. **Go to GitHub Actions** and find the CI run for that commit
3. **Download the SBOM artifact** `sbom-<commit-sha>.json`

Alternatively, if your deployment records the full image digest (e.g., in a Kubernetes pod spec or an ECS task definition), use Option 2 above to extract the SBOM directly from the image.

## SBOM Contents Baseline

As of commit 7620d26 (2026-09-24), the SBOM for a standard build includes:

- **Base image packages**: ~40-50 Alpine Linux packages (musl, openssl, ca-certificates, etc.)
- **npm dependencies**: 341 packages (116 in production, 225 dev-only excluded from runtime image)
- **Application**: 1 package (`ourdao-backend@0.1.0`)

The exact count varies slightly based on the base image's Alpine release and any transitive dependency updates in `package-lock.json`.

## Provenance vs. SBOM

Docker Buildx can generate two types of attestations:

- **SBOM** (enabled): Lists what is in the image
- **Provenance** (disabled): Describes how the image was built (source repo, build platform, build args)

We generate SBOMs but **not** provenance attestations (issue #219). Provenance is valuable for supply-chain security but adds complexity (requires a buildkit builder with attestation storage, larger image metadata) with limited immediate benefit for this project. SBOM alone covers the primary use case: knowing what packages are in a deployed image.

If provenance is needed later, set `provenance: true` in the `docker/build-push-action` step in `.github/workflows/ci.yml`.

## Related

- `.github/workflows/ci.yml` — CI job generating SBOM and uploading artifact
- `Dockerfile` — Base image digest pinning
- `docs/DEPENDENCY-LICENSES.md` — License policy for npm dependencies
- [SPDX Specification](https://spdx.dev/specifications/) — SBOM format standard
- [Docker SBOM documentation](https://docs.docker.com/build/attestations/sbom/) — How Docker generates SBOMs
