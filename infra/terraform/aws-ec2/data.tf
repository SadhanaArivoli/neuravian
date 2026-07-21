data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

data "aws_subnet" "selected" {
  id = local.selected_subnet_id
}

data "aws_ec2_instance_type" "selected" {
  instance_type = var.instance_type
}

data "aws_ec2_instance_type_offering" "selected" {
  location_type            = "availability-zone"
  preferred_instance_types = [var.instance_type]

  filter {
    name   = "location"
    values = [data.aws_subnet.selected.availability_zone]
  }
}

data "aws_servicequotas_service_quota" "standard_vcpus" {
  service_code = "ec2"
  quota_code   = "L-1216C47A"
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name            = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
  with_decryption = false
}

data "aws_ami" "ubuntu" {
  most_recent = false
  owners      = ["099720109477"]

  filter {
    name   = "image-id"
    values = [data.aws_ssm_parameter.ubuntu_ami.insecure_value]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}
