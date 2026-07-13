output "server_ipv4" {
  description = "Public IPv4 address of the miner host"
  value       = hcloud_server.miner.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the miner host"
  value       = hcloud_server.miner.ipv6_address
}

output "ssh_command" {
  description = "SSH command to access the miner host"
  value       = "ssh ubuntu@${hcloud_server.miner.ipv4_address}"
}

output "volume_device" {
  description = "Linux block device path for the /data/miner volume"
  value       = hcloud_volume.miner_data.linux_device
}

output "data_mount" {
  description = "Where the persistent volume is mounted — the miner's GITTENSORY_MINER_CONFIG_DIR. Point the miner container's state mount here."
  value       = "/data/miner"
}
