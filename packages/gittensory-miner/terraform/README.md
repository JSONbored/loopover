# Fleet-mode AMS host — Terraform starter module

A minimal, self-contained Terraform module that provisions a dedicated **fleet-mode** host for the Autonomous
Miner System (AMS / `gittensory-miner`) on Hetzner Cloud — for operators who want the miner running as an
always-on CLI worker instead of in laptop mode.

It stands up a single firewalled VM with Docker pre-installed and a persistent volume mounted at `/data/miner`,
then gets out of the way. It is **not** the root [`terraform/`](../../../terraform/) module, which provisions the
multi-tenant ORB server (persistent HTTP service behind Caddy); this module exposes **no public endpoints** —
the miner only makes outbound calls, so the sole inbound rule is SSH.

## What it creates

| Resource                  | Purpose                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `hcloud_server`           | One Ubuntu 24.04 VM, CLI-worker sized (`server_type` default `cx22` = 2 vCPU / 4 GB)          |
| `hcloud_firewall`         | Inbound **SSH only**, scoped to `admin_ip_allowlist` — no 80/443/app ports                    |
| `hcloud_volume` (+ attach)| Persistent ext4 volume mounted at `/data/miner` so all local stores survive re-provisioning   |
| `hcloud_ssh_key`          | Your SSH public key, for access                                                              |

Docker is installed on first boot via cloud-init user-data (no manual provisioner step).

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) `>= 1.6`
- A Hetzner Cloud project + API token (console.hetzner.cloud → Security → API Tokens)
- An SSH key pair

## Usage

```sh
cd packages/gittensory-miner/terraform

export TF_VAR_hcloud_token="…"                       # or set it in a *.tfvars file (never commit it)
terraform init
terraform plan  -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)"
terraform apply -var "ssh_public_key=$(cat ~/.ssh/id_ed25519.pub)"
```

Useful variables (see [`variables.tf`](variables.tf) for all): `server_type`, `location`, `volume_size_gb`,
`admin_ip_allowlist` (restrict this to your IP in production).

## After apply — start the miner

The module provisions the **host**; you finish the miner setup over SSH (secrets never live in Terraform state):

1. `terraform output ssh_command` → SSH in.
2. Create a `.gittensory-miner.env` with your `GITHUB_TOKEN` and coding-agent provider credentials — see
   [`../.gittensory-miner.env.example`](../.gittensory-miner.env.example).
3. Run the miner container against the mounted volume using the existing
   [`../docker-compose.miner.yml`](../docker-compose.miner.yml) (its state mount is already pinned to
   `/data/miner`, which `terraform output data_mount` confirms). Full run/upgrade guidance lives in
   [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## Outputs

| Output          | Description                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `server_ipv4`   | Public IPv4 of the host                                                  |
| `server_ipv6`   | Public IPv6 of the host                                                  |
| `ssh_command`   | Ready-to-run SSH command                                                 |
| `volume_device` | Block device path for the data volume                                   |
| `data_mount`    | `/data/miner` — the miner's `GITTENSORY_MINER_CONFIG_DIR`; the run mount |
