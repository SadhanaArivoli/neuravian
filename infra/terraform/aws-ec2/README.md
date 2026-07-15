# NeuroForge Terraform deployment for one AWS EC2 instance

This root module provisions one native x86_64 NeuroForge verification VM and
deploys the public repository at an exact Git commit. It follows the reviewed
security decisions in [`docs/cloud/aws-automated-deployment-architecture.md`](../../../docs/cloud/aws-automated-deployment-architecture.md).

Terraform code is safe to commit. Terraform state, plans, credentials, private
keys, participant data, FreeSurfer licenses, and application secrets are not.

## What this creates

- one native x86 EC2 instance in `us-east-1`: `m7i.2xlarge` by default or the
  smaller Free-plan-compatible `m7i-flex.large` profile;
- the current Canonical Ubuntu Server 24.04 LTS AMD64 gp3 AMI resolved through
  its public SSM parameter and independently owner/architecture filtered;
- one encrypted 200 GiB gp3 root volume with 3,000 IOPS, 125 MiB/s, and
  `DeleteOnTermination=true`;
- one deployment-specific security group with TCP 22 from one operator IPv4
  `/32` and no inbound application ports;
- one EC2 key-pair record made from a supplied **public** key;
- one EC2-trusted instance role and profile with no AWS API policy;
- IMDSv2 required with hop limit 1;
- termination protection enabled by default;
- Docker Engine, Compose, an exact NeuroForge Git checkout, and a systemd unit
  that builds and starts the frontend/backend automatically;
- frontend/backend bound only to `127.0.0.1:3000` and `127.0.0.1:8000`.

It does not create a VPC, NAT Gateway, Elastic IP, load balancer, S3 bucket,
database, DNS record, TLS certificate, cluster, or scientific pipeline.

For AWS Free account plans, set `instance_type = "m7i-flex.large"`. This is an
x86_64, Free Tier-eligible 2-vCPU/8-GiB profile intended to bring up the app for
functional verification. It is slower and is not equivalent to the 8-vCPU,
32-GiB `m7i.2xlarge` full x86 verification environment.

## Authentication and prerequisites

Required locally:

- Terraform 1.10 or newer, below 2.0;
- AWS CLI authenticated as a non-root IAM principal;
- an existing AWS default VPC with a public subnet in `us-east-1`;
- an OpenSSH public/private key pair;
- permission to create the resources listed above.

Use an AWS CLI profile or standard environment variables. Never put credentials
in `.tf`, `.tfvars`, shell arguments, Git, user-data, or the VM.

```bash
# LOCAL MAC
aws configure --profile neuroforge-deployer
export AWS_PROFILE=neuroforge-deployer
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

The existing administrator IAM user can run Terraform, but its credentials are
not copied to EC2. For recurring use, replace administrator access with a
reviewed least-privilege deployment role.

## Configure

```bash
# LOCAL MAC
cd infra/terraform/aws-ec2
cp terraform.tfvars.example terraform.tfvars
chmod 600 terraform.tfvars

# Create a key outside the repository if one does not already exist.
ssh-keygen -t ed25519 -f "$HOME/.ssh/neuroforge-terraform" -C neuroforge-terraform
chmod 400 "$HOME/.ssh/neuroforge-terraform"

# Put only the .pub content in ssh_public_key.
# Set operator_ssh_cidr to the current public IPv4 followed by /32.
# Set git_commit to an exact reviewed 40-character commit from this repository.
```

Do not use the example documentation address `203.0.113.10/32` in a real plan.

## Initialize, validate, and plan

These commands install the provider and make read-only AWS queries. They do not
create resources:

```bash
# LOCAL MAC
terraform fmt -check -recursive
terraform init
terraform validate
terraform plan -out neuroforge.tfplan
terraform show neuroforge.tfplan
```

Review the plan for exactly:

- one instance, key pair, security group, role, and instance profile;
- TCP 22 from the expected `/32` only;
- no inbound 3000/8000;
- the expected AMI owner and x86_64 architecture;
- encrypted 200 GiB gp3 storage deleted on termination;
- an empty-permission instance role;
- no unexpected AWS services.

The generated plan can contain account and resource metadata. It is ignored and
must not be committed or shared publicly.

## Apply only after explicit review

```bash
# LOCAL MAC — MUTATES AWS AND INCURS COST
terraform apply neuroforge.tfplan
```

This command is intentionally documented but was not executed while generating
this module.

## Verify deployment

Cloud-init builds both application images, starts `neuroforge.service`, waits
for frontend/backend health, verifies loopback listeners, and writes:

```text
/var/lib/neuroforge/terraform-bootstrap-complete.json
```

After `terraform apply` finishes:

```bash
# LOCAL MAC
chmod 400 "$HOME/.ssh/neuroforge-terraform"
./scripts/verify.sh --identity-file "$HOME/.ssh/neuroforge-terraform"
terraform output -raw tunnel_command
```

Open the displayed tunnel, then use `http://127.0.0.1:3000`. Do not add public
rules for ports 3000 or 8000.

### Private GitHub repository

Do not put a GitHub token, deploy-key private key, or other repository secret
in Terraform variables, state, user-data, or the VM image. For a private
repository, transfer a Git bundle containing the exact configured commit over
the deployment SSH connection and run the credential-free completion helper:

```bash
# LOCAL MAC, from the repository root
git bundle create /private/tmp/neuroforge.bundle codex/aws-terraform-ec2-deployment
scp -i "$HOME/.ssh/neuroforge-terraform" \
  /private/tmp/neuroforge.bundle \
  infra/terraform/aws-ec2/scripts/complete-private-bootstrap.sh \
  "ubuntu@$(terraform -chdir=infra/terraform/aws-ec2 output -raw public_ip):/tmp/"

ssh -i "$HOME/.ssh/neuroforge-terraform" \
  "ubuntu@$(terraform -chdir=infra/terraform/aws-ec2 output -raw public_ip)" \
  "sudo bash /tmp/complete-private-bootstrap.sh /tmp/neuroforge.bundle \
  $(terraform -chdir=infra/terraform/aws-ec2 output -raw deployed_git_commit)"
```

Use a local branch or ref that contains the configured commit. The helper
verifies the bundle and exact commit, preserves any failed checkout, starts the
same loopback-only Compose service, and writes the normal completion marker.
The GitHub credential never reaches EC2.

On the VM, bootstrap logs are at:

```text
/var/log/neuroforge-terraform-bootstrap.log
```

## Updates

To deploy another reviewed repository commit, update `git_commit` and plan.
Because user-data changes replace the instance, preserve any required evidence
or data before applying the replacement plan.

## Cost and stopping

The running instance, public IPv4, and EBS volume incur charges. Stopping the
instance stops compute and running public-IPv4 charges, but the encrypted EBS
volume continues charging. Use the existing AWS preflight tooling for a current
price estimate; prices in documentation are not guarantees.

```bash
# LOCAL MAC — MUTATES AWS, reversible
aws ec2 stop-instances --region us-east-1 --instance-ids "$(terraform output -raw instance_id)"
```

## Evidence-preserving teardown

The root volume is deleted with the instance. Before teardown, download and
open all evidence, verify its checksum, and store it outside the repository.

Termination protection makes teardown intentionally two-step:

1. Set `enable_termination_protection = false` in the private `terraform.tfvars`.
2. Run and review a dedicated plan that changes only termination protection:

   ```bash
   # LOCAL MAC — MUTATES AWS AFTER APPLY
   terraform plan -out disable-protection.tfplan
   terraform show disable-protection.tfplan
   terraform apply disable-protection.tfplan
   ```

3. Re-run `terraform plan -destroy`, verify the exact deployment IDs/tags, then:

   ```bash
   # LOCAL MAC — DESTRUCTIVE AND BILLABLE RESOURCES ARE REMOVED
   terraform plan -destroy -out destroy.tfplan
   terraform show destroy.tfplan
   terraform apply destroy.tfplan
   ```

4. Independently check EC2 instances, volumes, security groups, key pairs, IAM
   resources, and the Billing console. Billing data can lag deletion.

Do not use `terraform destroy -auto-approve`. Do not delete the local private
key until evidence is safely preserved and residual-resource verification is
complete.

## State and collaboration

This module defaults to local state because it creates no extra AWS services.
Local state is sensitive operational data and is ignored. Teams should design
and review an encrypted, locked remote-state backend separately before use;
never improvise an S3 backend in this module.
