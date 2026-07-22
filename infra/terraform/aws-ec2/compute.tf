resource "aws_instance" "neuravian" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.selected.id
  vpc_security_group_ids = [aws_security_group.neuravian.id]
  key_name               = aws_key_pair.neuravian.key_name
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  associate_public_ip_address          = true
  disable_api_termination              = var.enable_termination_protection
  instance_initiated_shutdown_behavior = "stop"
  ebs_optimized                        = true
  monitoring                           = false
  source_dest_check                    = true
  user_data                            = local.cloud_init
  user_data_replace_on_change          = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    delete_on_termination = true
    encrypted             = true
    volume_size           = 200
    volume_type           = "gp3"
    iops                  = 3000
    throughput            = 125
    tags                  = local.resource_tags
  }

  tags = local.resource_tags

  lifecycle {
    # AWS clears an automatically assigned public IPv4 address when an instance
    # stops. That expected drift must never force replacement of the instance
    # or its delete-on-termination root volume during an in-place resize.
    ignore_changes = [associate_public_ip_address]

    precondition {
      condition     = data.aws_ami.ubuntu.architecture == "x86_64"
      error_message = "The resolved Ubuntu AMI must be x86_64."
    }

    precondition {
      condition     = data.aws_ami.ubuntu.owner_id == "099720109477"
      error_message = "The resolved Ubuntu AMI must be owned by Canonical."
    }

    precondition {
      condition = (
        (
          var.instance_type == "m7i.2xlarge" &&
          data.aws_ec2_instance_type.selected.default_vcpus == 8 &&
          data.aws_ec2_instance_type.selected.memory_size == 32768
          ) || (
          var.instance_type == "m7i-flex.large" &&
          data.aws_ec2_instance_type.selected.default_vcpus == 2 &&
          data.aws_ec2_instance_type.selected.memory_size == 8192
        )
        ) && (
        contains(data.aws_ec2_instance_type.selected.supported_architectures, "x86_64")
      )
      error_message = "The selected instance type must resolve to its reviewed x86_64 CPU and memory shape."
    }

    precondition {
      condition     = data.aws_ec2_instance_type_offering.selected.instance_type == var.instance_type
      error_message = "The selected instance type must be offered in the selected availability zone."
    }

    precondition {
      condition     = data.aws_servicequotas_service_quota.standard_vcpus.value >= data.aws_ec2_instance_type.selected.default_vcpus
      error_message = "The regional On-Demand Standard instance quota must cover the selected instance vCPUs."
    }

    precondition {
      condition     = data.aws_caller_identity.current.arn != "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
      error_message = "Terraform must not run as the AWS account root identity."
    }
  }

  depends_on = [aws_iam_instance_profile.instance]
}
