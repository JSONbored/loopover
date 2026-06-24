variable "hcloud_token" {
  description = "Hetzner Cloud API token (generate at console.hetzner.cloud → Security → API Tokens)"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key content for server access (e.g. file('~/.ssh/id_ed25519.pub'))"
  type        = string
}

variable "server_type" {
  description = "Hetzner server type. cx22 = 2 vCPU / 4 GB (sufficient for <50 reviews/day). cpx21 = 3 vCPU AMD / 4 GB for heavier load."
  type        = string
  default     = "cx22"
}

variable "location" {
  description = "Hetzner datacenter location: nbg1 (Nuremberg), fsn1 (Falkenstein), hel1 (Helsinki), ash (Ashburn VA), sin (Singapore)"
  type        = string
  default     = "nbg1"
}

variable "volume_size_gb" {
  description = "Size of the persistent data volume in GB (holds the SQLite DB and Litestream WAL segments)"
  type        = number
  default     = 20
}

variable "admin_ip_allowlist" {
  description = "CIDR ranges allowed to SSH and access the raw app port (8787). Restrict to your IP(s) in production."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
