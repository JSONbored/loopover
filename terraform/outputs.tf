output "server_ipv4" {
  description = "Public IPv4 address of the gittensory server"
  value       = hcloud_server.gittensory.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the gittensory server"
  value       = hcloud_server.gittensory.ipv6_address
}

output "ssh_command" {
  description = "SSH command to access the server"
  value       = "ssh ubuntu@${hcloud_server.gittensory.ipv4_address}"
}

output "volume_device" {
  description = "Linux block device path for the data volume"
  value       = hcloud_volume.gittensory_data.linux_device
}
