# Package inventory (SBOM) for Agent Flow

This folder holds the software bill of materials (package inventory) for the Agent Flow container image.

| File | What it is |
|---|---|
| `agent-flow.cdx.json` | CycloneDX JSON (OS packages, npm packages, and Python packages if any). Machine-readable. |
| `agent-flow.md` | Human-readable table of name, version and type, plus the base image and its digest, the image build date and the git sha the image was built from. |

**Status: the files are not yet generated in the repo.** They appear after the first run of `scripts/rebuild.sh` or `scripts/sbom.sh` on a machine with docker. The PR that added this folder was authored in a sandbox without docker, so no inventory has been produced yet. Once generated, commit both files.

## How they are generated

```bash
scripts/sbom.sh [image]     # default image: agent-flow:local
```

- The scanner is [syft](https://github.com/anchore/syft) **1.18.1**. The script downloads the pinned release for linux amd64 or arm64, verifies its sha256 checksum, and installs it to `.bin/syft-1.18.1`. `.bin/` is git-ignored.
- With no arguments and `SBOM_SKIP_BUILD` unset, the script first runs `docker compose build`. It then scans the image (default `agent-flow:local`). Passing an image argument, or setting `SBOM_SKIP_BUILD=1`, skips the build step.
- The base image is read from the last `FROM` line of the `Dockerfile`, and its digest is recorded.

Environment variables:

| Variable | Effect |
|---|---|
| `SBOM_SKIP_BUILD=1` | Scan the existing image and do not run `docker compose build`. |
| `SBOM_PUBLISH_DIR=<dir>` | Where to copy the CycloneDX file. Default `/home/scott/sbom/agent-flow`. |
| `SYFT_BIN=<path>` | Use an existing syft binary. Skips the download and the checksum check. |

Regeneration on deploy: `scripts/rebuild.sh` wraps `docker compose up -d --build` and then runs `scripts/sbom.sh`, so the inventory is refreshed on every deploy. An SBOM failure does not stop a running deploy; `rebuild.sh` prints a warning instead.

## Publishing to Prodigy

On Prodigy, the CycloneDX file is copied to `/home/scott/sbom/agent-flow/agent-flow.cdx.json`. Argus (`metal-phoenix/argus`, the nightly security check) reads it from there. On machines where that directory cannot be created, the copy is skipped without error.
