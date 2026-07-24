#!/bin/sh
# Root-privileged entrypoint wrapper for #7857's network-egress enforcement. This is the ONLY thing in the
# image that ever runs as root: it generates + applies the egress firewall (dnsmasq + iptables/ipset,
# generate-egress-firewall-config.js does the config generation, this script does the privileged apply), then
# drops to the unprivileged `node` user and execs the real entrypoint -- everything after the final `exec
# gosu` line is byte-identical to this image's pre-#7857 behavior, running as `node`, same as always.
#
# Deny-by-default per #7648's ratified decision -- fails CLOSED, deliberately: `set -eu` means a failure
# anywhere in firewall setup (dnsmasq won't start, an iptables command errors) aborts the container rather than
# silently falling through to running an untrusted coding-agent subprocess with NO network restriction at all.
#
# Deliberately unconditional: LOOPOVER_MINER_DISABLE_EGRESS_FIREWALL (the documented escape hatch for an
# operator who hits a real snag) is decided in generate-egress-firewall-config.js, not here -- when set, that
# script still writes a real dnsmasq config but a no-op ruleset (renderDisabledRuleset), so this script's own
# flow never needs to know or care; it always generates, always starts dnsmasq, always applies whatever
# ruleset was written.
set -eu

DNSMASQ_CONF=/etc/dnsmasq.d/loopover-egress.conf
RULESET_SCRIPT=/tmp/loopover-egress-ruleset.sh

node /app/packages/loopover-miner/lib/generate-egress-firewall-config.js "$DNSMASQ_CONF" "$RULESET_SCRIPT"

# Listens on 127.0.0.1 only (per the generated config's own bind-interfaces + listen-address) -- unreachable
# from outside this container regardless of what else is on its network. --user/--group are explicit rather
# than relying on dnsmasq's own default privilege drop (confirmed empirically: it already drops to nobody:65534
# unprompted on this base image) -- explicit beats implicit for a root-invoked daemon, regardless of what the
# current default happens to be. Deliberately `nobody`, not the `node` user the miner itself runs as: dnsmasq
# needs none of node's file access, and running it as the SAME user as the application would only widen what a
# dnsmasq-specific compromise could reach.
dnsmasq --conf-file="$DNSMASQ_CONF" --pid-file=/var/run/dnsmasq.pid --user=nobody --group=nogroup

# Docker writes its own /etc/resolv.conf pointing at its embedded DNS server -- nothing routes lookups through
# dnsmasq until this container's OWN resolver config says to. Docker's own generated file says "this file can
# be edited" (confirmed empirically); this is the one intentional edit.
echo "nameserver 127.0.0.1" > /etc/resolv.conf

sh "$RULESET_SCRIPT"

exec gosu node loopover-miner "$@"
