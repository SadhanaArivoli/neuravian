data "aws_iam_policy_document" "ec2_trust" {
  statement {
    sid     = "AllowEc2AssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "NeuravianInstance-${var.deployment_id}"
  description        = "Permissionless instance role for ${local.name}"
  assume_role_policy = data.aws_iam_policy_document.ec2_trust.json

  tags = local.resource_tags
}

# Deliberately no aws_iam_role_policy or policy attachment. Neuravian and its
# containers do not require AWS API access for this deployment.
resource "aws_iam_instance_profile" "instance" {
  name = aws_iam_role.instance.name
  role = aws_iam_role.instance.name

  tags = local.resource_tags
}
