# Terraform starter module for a dedicated fleet-mode AMS (Autonomous Miner System) host on Hetzner Cloud.
# Provisions a single, firewalled VM with Docker pre-installed via cloud-init and a persistent volume mounted at
# /data/miner (the miner's built-in LOOPOVER_MINER_CONFIG_DIR default), so the append-only attempt log,
# prediction ledger, and every other local store survive instance recreation.
#
# This is the CLI-worker profile — it exposes NO public endpoints by default (unlike the root terraform/ module,
# which provisions the multi-tenant ORB server behind Caddy on 80/443). After `terraform apply`: SSH in, drop your
# secrets into a .gittensory-miner.env, and start the miner container against /data/miner. See README.md and
# ../docker-compose.miner.yml / ../DEPLOYMENT.md for the run step.

terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# ── SSH key ────────────────────────────────────────────────────────────────────
resource "hcloud_ssh_key" "miner" {
  name       = "gittensory-miner-deploy"
  public_key = var.ssh_public_key
}

# ── Firewall — CLI-worker profile: SSH in only, NO public endpoints ──────────────
# The miner makes only outbound calls (GitHub, the coding-agent provider); it serves nothing, so the sole inbound
# rule is SSH, scoped to your admin allowlist. Deliberately no 80/443/app-port rules — that is the ORB profile.
resource "hcloud_firewall" "miner" {
  name = "gittensory-miner"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.admin_ip_allowlist
  }
}

# ── Persistent volume for /data/miner (attempt log, prediction ledger, all local stores) ──
resource "hcloud_volume" "miner_data" {
  name     = "gittensory-miner-data"
  size     = var.volume_size_gb
  location = var.location
  format   = "ext4"
}

# ── Server ───────────────────────────────────────────────────────────────────────
# Docker is installed from Ubuntu's own `docker.io` package (declarative `packages:` — no third-party apt repo,
# no piped remote install scripts). cloud-init mounts the data volume at /data/miner only AFTER polling for its
# block device to appear (see the `until [ -b … ]` guard below): the volume is attached by a separate
# `hcloud_volume_attachment` resource, so this post-attachment wait is what prevents a first-boot race in which
# /data/miner could otherwise be silently backed by the root disk instead of the persistent volume.
resource "hcloud_server" "miner" {
  name         = "gittensory-miner"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.miner.id]
  firewall_ids = [hcloud_firewall.miner.id]
  keep_disk    = true

  user_data = <<-CLOUDINIT
    #cloud-config
    package_update: true
    package_upgrade: true

    packages:
      - docker.io
      - git
      - jq

    runcmd:
      - systemctl enable --now docker
      - usermod -aG docker ubuntu
      - mkdir -p /data/miner
      # Wait for the attached volume's block device before mounting, so /data/miner is always the persistent
      # volume and never races the attachment on first boot.
      - ["bash", "-c", "until [ -b /dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.miner_data.id} ]; do sleep 2; done"]
      - mount /dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.miner_data.id} /data/miner
      - echo "/dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.miner_data.id} /data/miner ext4 discard,nofail,defaults 0 0" >> /etc/fstab
      - echo "cloud-init: gittensory-miner host ready — see terraform/README.md for the run step" > /var/log/gittensory-miner-init.log
  CLOUDINIT

  labels = {
    app     = "gittensory-miner"
    managed = "terraform"
  }
}

# Attach the volume to the server. The server's cloud-init polls for the resulting block device (above) before
# mounting, so the ordering between this attachment and first boot cannot leave /data/miner unbacked.
resource "hcloud_volume_attachment" "miner_data" {
  server_id = hcloud_server.miner.id
  volume_id = hcloud_volume.miner_data.id
  automount = false
}
