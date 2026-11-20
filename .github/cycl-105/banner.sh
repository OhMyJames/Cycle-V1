#!/bin/bash
set -euo pipefail
root=$(mktemp -d /tmp/cycl105-banner.XXXXXX)
old=$1
new=$2
mkdir "$root/bin" "$root/electron" "$root/remote-home" "$root/local-home"
ln -s "$old" "$root/remote-daemon"
cleanup() {
  for d in remote local; do
    "$old" stop --data-dir "$root/$d" >/dev/null 2>&1 || true
  done
  python3 -c 'import shutil,sys;shutil.rmtree(sys.argv[1])' "$root"
}
trap cleanup EXIT
ssh-keygen -q -t ed25519 -N '' -f "$root/host"
ssh-keygen -q -t ed25519 -N '' -f "$root/client"
cat > "$root/sshd_config" <<CONF
HostKey $root/host
AuthorizedKeysFile $root/client.pub
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
DisableForwarding yes
PermitTTY no
ForceCommand /usr/bin/env -i HOME=$root/remote-home PATH=/usr/bin:/bin $root/remote-daemon proxy --data-dir $root/remote
CONF
read -r type key comment < "$root/host.pub"
echo "cycl105-test $type $key" > "$root/known"
cat > "$root/ssh_config" <<CONF
Host cycl105-test
    ProxyCommand /usr/sbin/sshd -i -e -f $root/sshd_config
    IdentityFile $root/client
    IdentitiesOnly yes
    IdentityAgent none
    StrictHostKeyChecking yes
    UserKnownHostsFile $root/known
    GlobalKnownHostsFile /dev/null
CONF
cat > "$root/bin/ssh" <<SH
#!/bin/sh
exec /usr/bin/ssh -F "$root/ssh_config" "\$@"
SH
chmod 700 "$root/bin/ssh"
cat > "$root/electron/settings.json" <<'JSON'
{"environments":[{"id":"far","name":"CYCL-105 SSH","kind":"remote","transport":{"type":"ssh","host":"cycl105-test"}}]}
JSON
bun .github/cycl-105/banner.mjs "$root" "$old" "$new"
