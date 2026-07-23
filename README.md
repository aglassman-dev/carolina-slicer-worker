# Carolina Slicer Worker

This repository contains the open-source slicer worker used by Carolina Quote Engine. It is deliberately separate from the private paid platform.

The public worker is available at <https://github.com/aglassman-dev/carolina-slicer-worker>. The hosted Carolina Quote Engine remains a separate private application.

The worker:

- claims versioned jobs through a narrow authenticated HTTPS API;
- verifies signed, expiring job envelopes;
- downloads only short-lived encrypted input;
- decrypts client geometry in a private per-job directory;
- runs a separately installed Bambu Studio or compatible slicer;
- returns signed, normalized production metadata;
- deletes decrypted input and generated manufacturing artifacts after every job.

It does not contain the Carolina Quote Engine website, pricing system, payment processing, AI prompts, customer records, or production credentials.

## Architecture

The paid platform creates a short-lived, signed job and exposes the encrypted source file through a one-use worker endpoint. This worker validates the job, decrypts the model only inside an isolated work directory, slices it, and returns a signed normalized result. Client quantities, pricing, margins, credits, PDFs, and customer-facing output are handled only by the private platform.

Embedded slicer-project 3MF files are sliced once with their saved machine, color, material, resolution, plate, orientation, and support settings. The private platform maps those verified project totals to the requested number of finished assemblies; that commercial interpretation is intentionally outside this repository.

## License

This worker is licensed under the GNU Affero General Public License v3.0 only. Bambu Studio and OrcaSlicer are separately installed AGPL programs and are not bundled here. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Requirements

- Node.js 24 or newer
- pnpm
- a separately installed and legally compliant Bambu Studio or compatible slicer build
- reviewed machine, process, and filament profiles
- two different random secrets of at least 32 bytes
- an HTTPS Carolina-compatible job API

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

Copy `slicer-worker/profile-catalog.example.json` outside the repository and set its `profileRoot` to your installed profile directory.

## Run against a remote queue

```bash
export QUOTE_ENGINE_BASE_URL="https://quoteengine.example.com"
export SLICER_WORKER_TOKEN="independent-random-secret"
export SLICE_JOB_SIGNING_SECRET="different-independent-random-secret"
export SLICER_WORKER_ID="slicer-worker-1"

pnpm worker:remote -- \
  --engine "/path/to/BambuStudio" \
  --catalog "/path/to/profile-catalog.json" \
  --work-root "/private/carolina-slicer-worker" \
  --watch
```

Outside local development, the platform URL must use HTTPS. Never commit secrets, client models, generated G-code, or production profile overrides.

## Security boundary

Run the worker as an unprivileged user in an isolated VM or container. Restrict outbound traffic to the quote-engine origin, use a private ephemeral work volume, and enforce CPU, memory, process, disk, and wall-clock limits. Production operators should monitor queue age and sanitized failure categories without logging client content.

Security reports should follow [SECURITY.md](./SECURITY.md).

## Isolated DigitalOcean worker

The included container pins Bambu Studio `v02.07.01.62` by SHA-256 and runs the worker as an unprivileged user. The DigitalOcean deployment files configure a dedicated egress-only worker VM with no application port, a read-only container filesystem, memory-backed work directories, dropped Linux capabilities, bounded CPU/RAM/processes, log rotation, a host firewall, automatic security updates, and restart-on-failure.

Use a 64-bit Ubuntu 22.04 Basic Droplet with at least 2 vCPUs and 4 GB RAM. Supply `deploy/digitalocean/cloud-init.yaml` as user data when creating it. The bootstrap intentionally leaves the worker service stopped until two independent production secrets are installed in `/etc/carolina-slicer-worker.env`.

After provisioning:

```bash
sudo chmod 600 /etc/carolina-slicer-worker.env
sudo systemctl enable --now carolina-slicer-worker
sudo systemctl status carolina-slicer-worker
```

Do not place either secret in cloud-init, source control, shell history, screenshots, or support tickets. Keep inbound firewall access limited to SSH from trusted administrator addresses.
