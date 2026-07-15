variable "aws_region" {
  description = "AWS region for the single NeuroForge verification instance."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "The reviewed NeuroForge x86 deployment is restricted to us-east-1."
  }
}

variable "deployment_id" {
  description = "Non-secret identifier used to name and tag this deployment."
  type        = string

  validation {
    condition     = can(regex("^nf-tf-[a-z0-9-]{8,32}$", var.deployment_id))
    error_message = "deployment_id must match nf-tf-[a-z0-9-]{8,32}."
  }
}

variable "instance_type" {
  description = "Native x86 deployment shape. Use m7i-flex.large for AWS Free account plans or m7i.2xlarge for full verification."
  type        = string
  default     = "m7i.2xlarge"

  validation {
    condition     = contains(["m7i.2xlarge", "m7i-flex.large"], var.instance_type)
    error_message = "instance_type must be m7i.2xlarge or the Free-plan-compatible m7i-flex.large."
  }
}

variable "operator_ssh_cidr" {
  description = "Current operator public IPv4 as one /32 CIDR, for example 203.0.113.10/32."
  type        = string

  validation {
    condition = (
      can(cidrhost(var.operator_ssh_cidr, 0)) &&
      can(regex("^[0-9.]+/32$", var.operator_ssh_cidr)) &&
      var.operator_ssh_cidr != "0.0.0.0/0"
    )
    error_message = "operator_ssh_cidr must be exactly one IPv4 /32 and cannot be 0.0.0.0/0."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key used for the deployment-specific EC2 key pair. Never provide a private key."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$", trimspace(var.ssh_public_key)))
    error_message = "ssh_public_key must contain one valid OpenSSH public key."
  }
}

variable "git_commit" {
  description = "Exact 40-character NeuroForge Git commit deployed to the instance."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.git_commit))
    error_message = "git_commit must be an exact lowercase 40-character Git SHA."
  }
}

variable "repository_url" {
  description = "Public NeuroForge repository cloned by cloud-init."
  type        = string
  default     = "https://github.com/SadhanaArivoli/neuroforge.git"

  validation {
    condition     = var.repository_url == "https://github.com/SadhanaArivoli/neuroforge.git"
    error_message = "This reviewed module deploys only SadhanaArivoli/neuroforge."
  }
}

variable "subnet_id" {
  description = "Optional existing public subnet in the default VPC. Null selects the first eligible subnet deterministically."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.subnet_id == null || can(regex("^subnet-[0-9a-f]+$", var.subnet_id))
    error_message = "subnet_id must be null or a valid subnet ID."
  }
}

variable "prepull_images" {
  description = "Pre-pull the repository's digest-pinned verification images during bootstrap."
  type        = bool
  default     = false
}

variable "enable_termination_protection" {
  description = "Protect the instance from termination. Keep true for create/update; set false only in a separate reviewed decommission plan after evidence is preserved."
  type        = bool
  default     = true
}

variable "additional_tags" {
  description = "Optional non-sensitive tags. Reserved ownership keys cannot be overridden."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(
      toset(keys(var.additional_tags)),
      toset(["Name", "Project", "Purpose", "ManagedBy", "DeploymentId"])
    )) == 0
    error_message = "additional_tags cannot override NeuroForge ownership tags."
  }
}
