#!/usr/bin/env bash
# Builds a throwaway MIT Kerberos realm on a CI runner for
# packages/engine/test/integration/auth/kerberos-real.test.ts. Every key is generated here and lives
# under $KRB_DIR; nothing is a real credential.
set -euo pipefail
KRB_DIR="${KRB_DIR:-$RUNNER_TEMP/krb}"
REALM=WIREBENCH.TEST
mkdir -p "$KRB_DIR"
cat > "$KRB_DIR/krb5.conf" <<CONF
[libdefaults]
  default_realm = $REALM
  dns_lookup_kdc = false
  dns_lookup_realm = false
  rdns = false
  dns_canonicalize_hostname = false
[realms]
  $REALM = {
    kdc = 127.0.0.1:88
    admin_server = 127.0.0.1:749
  }
[domain_realm]
  localhost = $REALM
CONF
sudo cp "$KRB_DIR/krb5.conf" /etc/krb5.conf
sudo mkdir -p /etc/krb5kdc
printf '[realms]\n  %s = {\n    acl_file = /etc/krb5kdc/kadm5.acl\n  }\n' "$REALM" | sudo tee /etc/krb5kdc/kdc.conf >/dev/null
echo '*/admin *' | sudo tee /etc/krb5kdc/kadm5.acl >/dev/null
sudo kdb5_util create -s -r "$REALM" -P "$(openssl rand -hex 16)"
sudo kadmin.local -q "addprinc -randkey alice@$REALM"
sudo kadmin.local -q "addprinc -randkey HTTP/localhost@$REALM"
sudo kadmin.local -q "ktadd -k $KRB_DIR/alice.keytab alice@$REALM"
sudo kadmin.local -q "ktadd -k $KRB_DIR/http.keytab HTTP/localhost@$REALM"
sudo chown "$(id -u)" "$KRB_DIR"/*.keytab
sudo systemctl restart krb5-kdc
# Smoke test: a realm that cannot issue alice a ticket fails this step, not the tests after it.
# Its own cache, so the tests start with none; a few tries while the KDC comes up.
export KRB5_CONFIG="$KRB_DIR/krb5.conf"
for attempt in 1 2 3 4 5; do
  if KRB5CCNAME="FILE:$KRB_DIR/smoke-ccache" kinit -kt "$KRB_DIR/alice.keytab" "alice@$REALM"; then
    break
  fi
  if [ "$attempt" -eq 5 ]; then
    echo "kinit as alice@$REALM failed: the throwaway realm is broken" >&2
    exit 1
  fi
  sleep 1
done
KRB5CCNAME="FILE:$KRB_DIR/smoke-ccache" kdestroy
{
  echo "KRB5_CONFIG=$KRB_DIR/krb5.conf"
  echo "KRB5_KTNAME=$KRB_DIR/http.keytab"
  echo "KRB5CCNAME=FILE:$KRB_DIR/ccache"
  echo "WIREBENCH_KRB_CLIENT_KEYTAB=$KRB_DIR/alice.keytab"
} >> "$GITHUB_ENV"
