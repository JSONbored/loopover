# Terraform config for a Hetzner Cloud VPS running the gittensory self-host stack.
# Provisions a single server with Docker + Docker Compose pre-installed via cloud-init.
# After provisioning: SSH in, clone the repo, copy .env.example → .env, and run
# `docker compose up -d` (or `docker compose --profile postgres --profile caddy up -d`).

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
resource "hcloud_ssh_key" "gittensory" {
  name       = "gittensory-deploy"
  public_key = var.ssh_public_key
}

# ── Firewall ───────────────────────────────────────────────────────────────────
resource "hcloud_firewall" "gittensory" {
  name = "gittensory"

  # SSH — tighten source_ips to your IP range in production
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.admin_ip_allowlist
  }

  # HTTP (Caddy ACME challenge + redirect)
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTPS
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # HTTP/3 QUIC (used by Caddy when the caddy profile is active)
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  # Direct app access — remove once behind Caddy
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "8787"
    source_ips = var.admin_ip_allowlist
  }
}

# ── Persistent volume for /data (SQLite DB + Litestream WAL) ──────────────────
resource "hcloud_volume" "gittensory_data" {
  name      = "gittensory-data"
  size      = var.volume_size_gb
  location  = var.location
  format    = "ext4"
  automount = false
}

# ── Server ─────────────────────────────────────────────────────────────────────
resource "hcloud_server" "gittensory" {
  name         = "gittensory"
  server_type  = var.server_type
  image        = "ubuntu-24.04"
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.gittensory.id]
  firewall_ids = [hcloud_firewall.gittensory.id]
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
      # Mount the attached volume at /data
      - mkdir -p /data
      - |
        DEVICE=$(lsblk -o NAME,SERIAL -dpn | grep $(echo "${hcloud_volume.gittensory_data.linux_device}" | sed 's|/dev/||') | awk '{print $1}')
        mount /dev/$$DEVICE /data
      - echo "LABEL=gittensory-data /data ext4 defaults 0 2" >> /etc/fstab
      # Allow the ubuntu user to run docker without sudo
      - usermod -aG docker ubuntu
      - echo "cloud-init: gittensory host ready" > /var/log/gittensory-init.log
  CLOUDINIT

  labels = {
    app     = "gittensory"
    managed = "terraform"
  }
}

# Attach the volume after the server is created
resource "hcloud_volume_attachment" "gittensory_data" {
  server_id = hcloud_server.gittensory.id
  volume_id = hcloud_volume.gittensory_data.id
  automount = true
}
