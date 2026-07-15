resource "aws_security_group" "neuroforge" {
  name        = local.name
  description = "NeuroForge SSH tunnel access from one operator IPv4"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH from the current NeuroForge operator"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.operator_ssh_cidr]
  }

  dynamic "ingress" {
    for_each = var.enable_public_frontend ? toset([80, 443]) : toset([])

    content {
      description = ingress.value == 80 ? "HTTP for HTTPS certificate issuance and redirect" : "Authenticated NeuroForge HTTPS gateway"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
  }

  egress {
    description = "Outbound package, GitHub, and container registry access"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.resource_tags

  lifecycle {
    precondition {
      condition     = data.aws_subnet.selected.vpc_id == data.aws_vpc.default.id
      error_message = "The selected subnet must belong to the default VPC."
    }

    precondition {
      condition     = data.aws_subnet.selected.map_public_ip_on_launch
      error_message = "The selected subnet must assign public IPv4 addresses."
    }
  }
}

resource "aws_key_pair" "neuroforge" {
  key_name   = local.name
  public_key = trimspace(var.ssh_public_key)

  tags = local.resource_tags
}
