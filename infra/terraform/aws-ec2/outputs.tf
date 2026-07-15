output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.neuroforge.id
}

output "instance_state" {
  description = "Current EC2 instance state."
  value       = aws_instance.neuroforge.instance_state
}

output "public_ip" {
  description = "Ephemeral public IPv4 used only for SSH and tunneling."
  value       = aws_instance.neuroforge.public_ip
}

output "private_ip" {
  description = "Instance private IPv4."
  value       = aws_instance.neuroforge.private_ip
}

output "ssh_command" {
  description = "SSH command. Replace the identity path with the private key matching ssh_public_key."
  value       = "ssh -i <private-key-path> ubuntu@${aws_instance.neuroforge.public_ip}"
}

output "tunnel_command" {
  description = "Local tunnel for the loopback-only NeuroForge frontend and backend."
  value       = "ssh -i <private-key-path> -L 3000:127.0.0.1:3000 -L 8000:127.0.0.1:8000 ubuntu@${aws_instance.neuroforge.public_ip}"
}

output "local_frontend_url" {
  description = "Frontend URL after opening the SSH tunnel."
  value       = "http://127.0.0.1:3000"
}

output "local_backend_health_url" {
  description = "Backend health URL after opening the SSH tunnel."
  value       = "http://127.0.0.1:8000/api/health"
}

output "public_frontend_url" {
  description = "HTTPS URL for the optional authenticated gateway. Reconfigure the gateway after any public-IP change."
  value       = var.enable_public_frontend ? "https://${replace(aws_instance.neuroforge.public_ip, ".", "-")}.sslip.io" : null
}

output "deployed_git_commit" {
  description = "Exact Git commit requested by cloud-init."
  value       = var.git_commit
}

output "instance_role_actions" {
  description = "AWS API actions granted to the instance role. Intentionally empty."
  value       = []
}
