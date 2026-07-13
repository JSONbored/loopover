# Terraform starter module for a dedicated fleet-mode AMS (Autonomous Miner System) host on Hetzner Cloud.
# Provisions a single, firewalled VM with Docker pre-installed via cloud-init and a persistent volume mounted at
# /data/miner (the miner's built-in GITTENSORY_MINER_CONFIG_DIR default), so the append-only attempt log,
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
  name      = "gittensory-miner-data"
  size      = var.volume_size_gb
  location  = var.location
  format    = "ext4"
  automount = false
}

# ── Server ───────────────────────────────────────────────────────────────────────
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
      - ca-certificates
      - curl
      - gnupg
      - git
      - jq

    runcmd:
      # Install Docker from the official apt repository
      - install -m 0755 -d /etc/apt/keyrings
      - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      - chmod a+r /etc/apt/keyrings/docker.gpg
      - |
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
        https://download.docker.com/linux/ubuntu \
        $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
        > /etc/apt/sources.list.d/docker.list
      - apt-get update -y
      - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      - systemctl enable --now docker
      # Mount the attached volume at /data/miner (the miner's fixed state dir)
      - mkdir -p /data/miner
      - |
        DEVICE=$(lsblk -o NAME,SERIAL -dpn | grep $(echo "${hcloud_volume.miner_data.linux_device}" | sed 's|/dev/||') | awk '{print $1}')
        mount /dev/$$DEVICE /data/miner
      - echo "LABEL=gittensory-miner-data /data/miner ext4 defaults 0 2" >> /etc/fstab
      # Allow the ubuntu user to run docker without sudo
      - usermod -aG docker ubuntu
      - echo "cloud-init: gittensory-miner host ready — see terraform/README.md for the run step" > /var/log/gittensory-miner-init.log
  CLOUDINIT

  labels = {
    app     = "gittensory-miner"
    managed = "terraform"
  }
}

# Attach the volume after the server is created
resource "hcloud_volume_attachment" "miner_data" {
  server_id = hcloud_server.miner.id
  volume_id = hcloud_volume.miner_data.id
  automount = true
}
