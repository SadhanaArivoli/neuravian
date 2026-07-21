mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "111111111111"
      arn        = "arn:aws:iam::111111111111:user/neuroforge-test"
      user_id    = "AIDATEST"
    }
  }

  mock_data "aws_vpc" {
    defaults = {
      id = "vpc-abc123"
    }
  }

  mock_data "aws_subnets" {
    defaults = {
      ids = ["subnet-abc123"]
    }
  }

  mock_data "aws_subnet" {
    defaults = {
      id                      = "subnet-abc123"
      vpc_id                  = "vpc-abc123"
      availability_zone       = "us-east-1a"
      map_public_ip_on_launch = true
    }
  }

  mock_data "aws_ec2_instance_type" {
    defaults = {
      instance_type           = "m7i.2xlarge"
      default_vcpus           = 8
      memory_size             = 32768
      supported_architectures = ["x86_64"]
    }
  }

  mock_data "aws_ec2_instance_type_offering" {
    defaults = {
      instance_type = "m7i.2xlarge"
      location      = "us-east-1a"
    }
  }

  mock_data "aws_servicequotas_service_quota" {
    defaults = {
      value = 64
    }
  }

  mock_data "aws_ssm_parameter" {
    defaults = {
      insecure_value = "ami-abc123"
      type           = "String"
    }
  }

  mock_data "aws_ami" {
    defaults = {
      id           = "ami-abc123"
      architecture = "x86_64"
      owner_id     = "099720109477"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}]}"
    }
  }
}

run "secure_single_instance_plan" {
  command = plan

  variables {
    deployment_id          = "nf-tf-20260714-test0001"
    instance_type          = "m7i.2xlarge"
    enable_public_frontend = false
    operator_ssh_cidr      = "203.0.113.10/32"
    ssh_public_key         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGV4YW1wbGVleGFtcGxlZXhhbXBsZQ test"
    git_commit             = "245c000a6092333429f5dea03befeea8bff982f7"
  }

  assert {
    condition     = aws_instance.neuroforge.instance_type == "m7i.2xlarge"
    error_message = "The plan must create the reviewed m7i.2xlarge shape."
  }

  assert {
    condition     = aws_instance.neuroforge.disable_api_termination
    error_message = "Termination protection must default to enabled."
  }

  assert {
    condition = (
      aws_instance.neuroforge.root_block_device[0].encrypted &&
      aws_instance.neuroforge.root_block_device[0].volume_size == 200 &&
      aws_instance.neuroforge.root_block_device[0].delete_on_termination
    )
    error_message = "The root volume security contract changed."
  }

  assert {
    condition = (
      length(aws_security_group.neuroforge.ingress) == 1 &&
      one(aws_security_group.neuroforge.ingress).from_port == 22 &&
      one(aws_security_group.neuroforge.ingress).to_port == 22 &&
      length(one(aws_security_group.neuroforge.ingress).cidr_blocks) == 1 &&
      contains(one(aws_security_group.neuroforge.ingress).cidr_blocks, "203.0.113.10/32")
    )
    error_message = "Security-group ingress must remain SSH-only from one /32."
  }

  assert {
    condition     = output.instance_role_actions == []
    error_message = "The instance role must have no AWS API actions."
  }
}
