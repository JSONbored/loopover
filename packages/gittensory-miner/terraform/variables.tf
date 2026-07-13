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
  description = "Hetzner server type — CLI-worker profile (one AMS instance running periodic attempt-runner work). cx22 = 2 vCPU / 4 GB is a modest starting point; scale up if you run a heavier coding-agent provider or higher concurrency. This is deliberately not ORB's higher-capacity multi-tenant sizing."
  type        = string
  default     = "cx22"
}

variable "location" {
  description = "Hetzner datacenter location: nbg1 (Nuremberg), fsn1 (Falkenstein), hel1 (Helsinki), ash (Ashburn VA), sin (Singapore)"
  type        = string
  default     = "nbg1"
}

variable "volume_size_gb" {
  description = "Size of the persistent /data/miner volume in GB. The local stores (attempt log, prediction ledger, plan/claim/portfolio/event/governor ledgers) are small SQLite files; 10 GB is ample for a single worker — grow it only if you retain a long attempt history."
  type        = number
  default     = 10

  validation {
    condition     = var.volume_size_gb >= 10
    error_message = "Hetzner Cloud volumes have a 10 GB minimum; set volume_size_gb to 10 or more."
  }
}

variable "admin_ip_allowlist" {
  description = "CIDR ranges allowed to SSH in. The miner exposes no inbound services, so this governs SSH only. Restrict to your IP(s) in production."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}
