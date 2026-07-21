locals {
  name = "neuroforge-${var.deployment_id}"

  required_tags = merge(var.additional_tags, {
    Project      = "NeuroForge"
    Purpose      = "x86-verification"
    ManagedBy    = "Terraform"
    DeploymentId = var.deployment_id
  })

  resource_tags = merge(local.required_tags, {
    Name = local.name
  })

  selected_subnet_id = var.subnet_id != null ? var.subnet_id : try(sort(data.aws_subnets.public.ids)[0], "")

  compose_override = file("${path.module}/templates/compose.aws-loopback.yaml")

  cloud_init = templatefile("${path.module}/templates/cloud-init.tftpl", {
    repository_url   = var.repository_url
    git_commit       = var.git_commit
    compose_override = local.compose_override
    prepull_images   = tostring(var.prepull_images)
  })
}
