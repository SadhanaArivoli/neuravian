#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 04-wait-and-verify.sh --config PATH [--dry-run]

CLOUDSHELL: verifies an already approved instance through read-only AWS calls
and SSH. --dry-run prints checks without contacting AWS or the VM.
EOF
}

CONFIG_PATH=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id

if [[ "${DRY_RUN}" == "true" ]]; then
  cat <<'EOF'
[CLOUDSHELL] DRY-RUN: wait for instance-status-ok
[CLOUDSHELL] DRY-RUN: verify m7i.2xlarge, x86_64, Canonical AMI, tags, one SG
[CLOUDSHELL] DRY-RUN: verify 200 GiB encrypted gp3 and DeleteOnTermination=true
[CLOUDSHELL] DRY-RUN: verify IMDSv2 required/hop-limit 1 and termination protection
[CLOUDSHELL] DRY-RUN: verify exact TCP 22 IPv4 /32 and no public 3000/8000
[REMOTE VM] DRY-RUN: verify Ubuntu 24.04, Docker, Compose, exact Git commit, bootstrap marker
[REMOTE VM] DRY-RUN: verify CPU/RAM/disk and that no container or scientific pipeline ran
EOF
  exit 0
fi

STATE_PATH="${STATE_ROOT}/state.json"
PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
[[ -s "${STATE_PATH}" && -s "${PREFLIGHT_PATH}" && -s "${IAM_PLAN_PATH}" ]] || die "Provisioning state/plans are missing"
read -r INSTANCE_ID SG_ID KEY_PATH DEPLOYER_ROLE_ARN < <(python3 - "${STATE_PATH}" "${IAM_PLAN_PATH}" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
iam = json.load(open(sys.argv[2]))
account = state["account_id"]
print(state["instance_id"], state["security_group_id"], state["cloudshell_key_path"], f"arn:aws:iam::{account}:role/{iam['deployer_role_name']}")
PY
)
[[ -s "${KEY_PATH}" ]] || die "CloudShell PEM is missing; use the verified local copy with a LOCAL MAC workflow"
[[ "$(stat -f '%Lp' "${KEY_PATH}" 2>/dev/null || stat -c '%a' "${KEY_PATH}")" == "400" ]] || die "PEM must have mode 400"

CREDENTIALS_FILE="$(mktemp "${TMPDIR:-/tmp}/neuravian-sts.XXXXXX")"
chmod 600 "${CREDENTIALS_FILE}"
aws sts assume-role --role-arn "${DEPLOYER_ROLE_ARN}" --role-session-name "verify-${RESOLVED_DEPLOYMENT_ID}" \
  --duration-seconds 3600 --output json >"${CREDENTIALS_FILE}"
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(python3 - "${CREDENTIALS_FILE}" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))["Credentials"]
print(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"])
PY
)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
rm -f "${CREDENTIALS_FILE}"
trap 'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN' EXIT

aws ec2 wait instance-status-ok --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
VERIFY_DIR="${STATE_ROOT}/verification"
install -d -m 0700 "${VERIFY_DIR}"
aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --output json >"${VERIFY_DIR}/instances.json"
aws ec2 describe-instance-attribute --region "${AWS_REGION}" --instance-id "${INSTANCE_ID}" \
  --attribute disableApiTermination --output json >"${VERIFY_DIR}/termination.json"
aws ec2 describe-security-groups --region "${AWS_REGION}" --group-ids "${SG_ID}" --output json >"${VERIFY_DIR}/security-group.json"
VOLUME_ID="$(python3 - "${VERIFY_DIR}/instances.json" <<'PY'
import json, sys
i = json.load(open(sys.argv[1]))["Reservations"][0]["Instances"][0]
print(i["BlockDeviceMappings"][0]["Ebs"]["VolumeId"])
PY
)"
aws ec2 describe-volumes --region "${AWS_REGION}" --volume-ids "${VOLUME_ID}" --output json >"${VERIFY_DIR}/volume.json"
python3 "${SCRIPT_DIR}/lib/verify_instance.py" \
  --state "${STATE_PATH}" --preflight "${PREFLIGHT_PATH}" \
  --instances "${VERIFY_DIR}/instances.json" --termination "${VERIFY_DIR}/termination.json" \
  --security-group "${VERIFY_DIR}/security-group.json" --volume "${VERIFY_DIR}/volume.json" \
  --output "${VERIFY_DIR}/control-plane.json" >/dev/null
PUBLIC_IP="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["public_ip"])' "${VERIFY_DIR}/control-plane.json")"
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
trap - EXIT

KNOWN_HOSTS="${STATE_ROOT}/known_hosts"
touch "${KNOWN_HOSTS}"
chmod 600 "${KNOWN_HOSTS}"
REMOTE_OUTPUT="${VERIFY_DIR}/remote.json"
ssh -i "${KEY_PATH}" -o BatchMode=yes -o ConnectTimeout=20 \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${KNOWN_HOSTS}" \
  "ubuntu@${PUBLIC_IP}" 'python3 -' >"${REMOTE_OUTPUT}" <<'PY'
import json, os, platform, shutil, subprocess
marker_path = "/var/lib/neuravian/bootstrap-complete.json"
marker = json.load(open(marker_path))
def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()
containers = command("docker", "ps", "-aq")
memory_kib = int(next(line.split()[1] for line in open("/proc/meminfo") if line.startswith("MemTotal:")))
disk = shutil.disk_usage("/home/ubuntu")
result = {
    "status": "GO",
    "architecture": platform.machine(),
    "os_release": dict(line.rstrip().split("=", 1) for line in open("/etc/os-release") if "=" in line),
    "docker": command("docker", "--version"),
    "compose": command("docker", "compose", "version"),
    "git_commit": command("git", "-C", "/home/ubuntu/neuravian", "rev-parse", "HEAD"),
    "cpu_count": os.cpu_count(),
    "memory_kib": memory_kib,
    "disk_total_bytes": disk.total,
    "bootstrap_marker": marker,
    "container_count": 0 if not containers else len(containers.splitlines()),
}
assert result["architecture"] == "x86_64"
assert result["os_release"].get("ID") == "ubuntu" and result["os_release"].get("VERSION_ID") == '"24.04"'
assert result["git_commit"] == "8b9614c328463c9dfcb5337303cadde447985299"
assert result["cpu_count"] >= 8 and result["memory_kib"] >= 30 * 1024 * 1024
assert result["disk_total_bytes"] >= 190 * 1024**3
assert marker["status"] == "complete" and marker["scientific_pipelines_run"] is False
assert result["container_count"] == 0
print(json.dumps(result, indent=2, sort_keys=True))
PY
chmod 600 "${REMOTE_OUTPUT}"

python3 - "${STATE_PATH}" "${PUBLIC_IP}" "${VOLUME_ID}" <<'PY'
import json, os, sys
path, public_ip, volume_id = sys.argv[1:]
state = json.load(open(path))
state.update({"public_ip": public_ip, "root_volume_id": volume_id, "lifecycle": "verified"})
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(state, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
info "Infrastructure and remote bootstrap verified; no scientific pipeline was executed"
