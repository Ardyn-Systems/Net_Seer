"""Compare a later survey with a baseline: what joined, what left, what moved, what changed.

The result is one graph holding every device from both surveys. Each device and link carries
``extra["change"]``:

- ``gone``: in the baseline only (no longer seen)
- ``detached``: still here, but no longer on a network it was on (a Wi-Fi network, an
  access point, a subnet, or a VLAN)
- ``new``: in the later survey only
- ``attached``: here before, and now on a network it wasn't on
- ``changed``: anything else that differs, such as moving between networks, a randomized MAC
  that rotated, or an access point that changed its name, security, or channel
- ``same``: nothing NetSeer can see changed

Links are ``removed``, ``added``, or ``same``. A device's reasons say what changed, in words.
"""

from __future__ import annotations

import copy
from typing import Any

from netseer.serialize import graph_from_dict

NETWORK_KINDS = {"subnet", "vlan"}
# A randomized MAC that disappeared and one that appeared are paired when this much
# evidence agrees (see _pair_score).
PAIR_THRESHOLD = 3.0
COMMON_FEATURE = 50  # more devices than this sharing a network or address: not distinctive


def is_device(node: dict[str, Any]) -> bool:
    return node.get("kind") not in NETWORK_KINDS


def is_ap(node: dict[str, Any] | None) -> bool:
    return bool(node) and (node.get("kind") == "ap" or "ap" in (node.get("roles") or []))


def node_mac(node: dict[str, Any]) -> str | None:
    macs = node.get("macs") or []
    if macs:
        return str(macs[0]).lower()
    nid = str(node.get("id", ""))
    return nid[4:].lower() if nid.startswith("mac:") else None


def is_randomized(mac: str | None) -> bool:
    """Locally administered MACs (second hex digit 2, 6, A, or E) are what phones randomize."""
    if not mac:
        return False
    try:
        return bool(int(mac.split(":")[0], 16) & 0x02)
    except ValueError:
        return False


GENERIC_LABELS = {"access point", "wireless client", "host", "server", "router", "gateway", "router or gateway"}


def _label(node: dict[str, Any] | None) -> str:
    """A name worth reading: the device's label, or its MAC when the label is only its type."""
    if not node:
        return "?"
    label = str(node.get("label") or "")
    if not label or label.lower() in GENERIC_LABELS or label == node.get("inferred_type"):
        return node_mac(node) or str(node.get("id"))
    return label


def _list(values) -> str:
    values = [str(v) for v in values]
    return ", ".join(values) if values else "none"


class _Side:
    """One survey, indexed for the questions a comparison asks."""

    def __init__(self, graph: dict[str, Any]):
        self.graph = graph
        self.nodes = {n["id"]: n for n in graph.get("nodes", [])}
        self.links = graph.get("links", [])
        self.devices = {k: n for k, n in self.nodes.items() if is_device(n)}
        self._att: dict[str, dict[str, str]] = {}
        for nid in self.devices:
            self._att[nid] = {}
        for link in self.links:
            a, b = link.get("source"), link.get("target")
            kind = link.get("kind")
            if kind == "wireless":
                for sta, ap in ((a, b), (b, a)):
                    sta_n, ap_n = self.nodes.get(sta), self.nodes.get(ap)
                    if sta_n and is_ap(ap_n) and not is_ap(sta_n):
                        ssid = link.get("label") if link.get("label") not in (None, "", "802.11") else None
                        ssid = ssid or next(iter(ap_n.get("ssids") or []), None)
                        if ssid:
                            self._att[sta][f"wifi:{ssid}"] = f"Wi-Fi {ssid}"
                        self._att[sta][f"ap:{ap}"] = f"access point {_label(ap_n)}"
            elif kind in NETWORK_KINDS:
                for dev, net in ((a, b), (b, a)):
                    net_n = self.nodes.get(net)
                    if dev in self.devices and net_n and not is_device(net_n):
                        self._att[dev][f"net:{net}"] = self._net_name(net_n)
        for net in self.nodes.values():
            if is_device(net):
                continue
            for member in (net.get("extra") or {}).get("members") or []:
                if member in self._att:
                    self._att[member][f"net:{net['id']}"] = self._net_name(net)
        # Which access points each SSID was heard from.
        self.ssid_aps: dict[str, set[str]] = {}
        for nid, node in self.devices.items():
            if is_ap(node):
                for ssid in node.get("ssids") or []:
                    self.ssid_aps.setdefault(ssid, set()).add(nid)

    @staticmethod
    def _net_name(node: dict[str, Any]) -> str:
        return f"{'VLAN' if node.get('kind') == 'vlan' else 'subnet'} {_label(node)}"

    def attachments(self, nid: str) -> dict[str, str]:
        return self._att.get(nid, {})

    def aliases(self, node: dict[str, Any]) -> set[str]:
        keys = {node["id"]}
        keys |= {f"mac:{str(m).lower()}" for m in node.get("macs") or []}
        keys |= {f"ip:{ip}" for ip in node.get("ips") or []}
        return keys

    def ssids(self, nid: str) -> set[str]:
        node = self.nodes.get(nid) or {}
        probed = (node.get("extra") or {}).get("probed_ssids") or []
        return {str(s) for s in [*(node.get("ssids") or []), *probed] if str(s).strip()}


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _features(side: _Side, nid: str) -> set[str]:
    out = {f"s:{ssid}" for ssid in side.ssids(nid)}
    out |= {k for k in side.attachments(nid) if k.startswith("ap:")}
    out |= {f"i:{ip}" for ip in side.nodes[nid].get("ips") or []}
    return out


def _pair_score(base: _Side, bid: str, cur: _Side, cid: str) -> tuple[float, list[str]]:
    """How sure we are that two randomized MACs are the same device, and why."""
    evidence = []
    score = 0.0
    s_b, s_c = base.ssids(bid), cur.ssids(cid)
    if s_b & s_c:
        score += 3 * _jaccard(s_b, s_c)
        evidence.append(f"the same networks ({_list(sorted(s_b & s_c))})")
    a_b = {k for k in base.attachments(bid) if k.startswith("ap:")}
    a_c = {k for k in cur.attachments(cid) if k.startswith("ap:")}
    if a_b & a_c:
        score += 3 * _jaccard(a_b, a_c)
        evidence.append("the same access point")
    ip_b = set(base.nodes[bid].get("ips") or [])
    ip_c = set(cur.nodes[cid].get("ips") or [])
    if ip_b & ip_c:
        score += 4
        evidence.append(f"the same address ({_list(sorted(ip_b & ip_c))})")
    if not evidence:
        return 0.0, []
    if base.nodes[bid].get("inferred_type") == cur.nodes[cid].get("inferred_type"):
        score += 0.5
    return score, evidence


def _match(base: _Side, cur: _Side) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Later device id -> baseline device id, and the evidence for MAC rotations."""
    matched: dict[str, str] = {}
    for cid in cur.devices:
        if cid in base.devices:
            matched[cid] = cid
    # The same device seen by address in one survey and by MAC in the other.
    alias_index: dict[str, set[str]] = {}
    for bid, node in base.devices.items():
        for key in base.aliases(node):
            alias_index.setdefault(key, set()).add(bid)
    taken = set(matched.values())
    for cid, node in cur.devices.items():
        if cid in matched:
            continue
        hits = set().union(*(alias_index.get(k, set()) for k in cur.aliases(node))) - taken
        if len(hits) == 1:
            bid = hits.pop()
            matched[cid] = bid
            taken.add(bid)
    # Randomized MACs that rotated: pair a vanished one with an appeared one by fingerprint.
    rotations: dict[str, list[str]] = {}
    gone = [b for b in base.devices if b not in taken and is_randomized(node_mac(base.devices[b]))]
    new = [c for c in cur.devices if c not in matched and is_randomized(node_mac(cur.devices[c]))]
    # Only pairs that share something are scored. Something hundreds of devices share (a
    # common hotspot name) is no evidence of identity, so it doesn't make a pair a candidate.
    index: dict[str, list[str]] = {}
    for cid in new:
        for feature in _features(cur, cid):
            index.setdefault(feature, []).append(cid)
    candidates = []
    for bid in gone:
        near = {cid for f in _features(base, bid) for cid in index.get(f, ()) if len(index[f]) <= COMMON_FEATURE}
        for cid in sorted(near):
            score, evidence = _pair_score(base, bid, cur, cid)
            if score >= PAIR_THRESHOLD:
                candidates.append((score, bid, cid, evidence))
    for _score, bid, cid, evidence in sorted(candidates, key=lambda c: (-c[0], c[1], c[2])):
        if bid in taken or cid in matched:
            continue
        matched[cid] = bid
        taken.add(bid)
        rotations[cid] = evidence
    return matched, rotations


def _attachment_changes(before: dict[str, str], after: dict[str, str]) -> tuple[str, list[str]]:
    """Status and reasons from the networks a device was on before and is on now."""
    reasons: list[str] = []
    left = joined = moved = False
    for prefix in ("wifi:", "net:"):
        lost = sorted(v for k, v in before.items() if k.startswith(prefix) and k not in after)
        gained = sorted(v for k, v in after.items() if k.startswith(prefix) and k not in before)
        if lost and gained:
            moved = True
            reasons.append(f"Moved from {_list(lost)} to {_list(gained)}")
        elif lost:
            left = True
            reasons.append(f"Left {_list(lost)}")
        elif gained:
            joined = True
            reasons.append(f"Joined {_list(gained)}")
    # Same Wi-Fi network, different access point: roaming.
    ap_lost = sorted(v for k, v in before.items() if k.startswith("ap:") and k not in after)
    ap_gained = sorted(v for k, v in after.items() if k.startswith("ap:") and k not in before)
    wifi_same = {k for k in before if k.startswith("wifi:")} == {k for k in after if k.startswith("wifi:")}
    if wifi_same and ap_lost and ap_gained:
        moved = True
        reasons.append(f"Roamed from {_list(ap_lost)} to {_list(ap_gained)}")
    elif wifi_same and ap_lost and not ap_gained:
        left = True
        reasons.append(f"Left {_list(ap_lost)}")
    elif wifi_same and ap_gained and not ap_lost:
        joined = True
        reasons.append(f"Joined {_list(ap_gained)}")
    if moved or (left and joined):
        return "changed", reasons
    if left:
        return "detached", reasons
    if joined:
        return "attached", reasons
    return "same", reasons


def _property_changes(b: dict[str, Any], c: dict[str, Any]) -> list[str]:
    reasons = []
    if is_ap(b) or is_ap(c):
        if set(b.get("ssids") or []) != set(c.get("ssids") or []) and (b.get("ssids") or c.get("ssids")):
            reasons.append(f"Network name changed from {_list(b.get('ssids') or [])} to {_list(c.get('ssids') or [])}")
        if set(b.get("encryption") or []) != set(c.get("encryption") or []) and (b.get("encryption") or c.get("encryption")):
            reasons.append(f"Security changed from {_list(b.get('encryption') or ['open'])} to {_list(c.get('encryption') or ['open'])}")
        if b.get("channels") and c.get("channels") and set(b["channels"]) != set(c["channels"]):
            reasons.append(f"Channel changed from {_list(b['channels'])} to {_list(c['channels'])}")
    if is_ap(b) != is_ap(c):
        reasons.append("Now acts as an access point" if is_ap(c) else "No longer acts as an access point")
    if b.get("ips") and c.get("ips") and set(b["ips"]) != set(c["ips"]):
        reasons.append(f"Address changed from {_list(b['ips'])} to {_list(c['ips'])}")
    if b.get("inferred_type") != c.get("inferred_type") and b.get("inferred_type") and c.get("inferred_type"):
        reasons.append(f"Type changed from {b['inferred_type']} to {c['inferred_type']}")
    new_services = sorted(set(c.get("services") or []) - set(b.get("services") or []))
    old_services = sorted(set(b.get("services") or []) - set(c.get("services") or []))
    if new_services:
        reasons.append(f"New services: {_list(new_services)}")
    if old_services:
        reasons.append(f"Services no longer seen: {_list(old_services)}")
    return reasons


def _strip_times(item: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(item)
    out["seen"] = []  # the two surveys' times don't share a timeline
    return out


def compare_graphs(
    baseline: dict[str, Any],
    later: dict[str, Any],
    *,
    baseline_name: str = "Baseline",
    later_name: str = "Later survey",
) -> dict[str, Any]:
    # Coerce both through the normal loader so every field has its usual shape.
    base = _Side(graph_from_dict(baseline).to_dict())
    cur = _Side(graph_from_dict(later).to_dict())
    matched, rotations = _match(base, cur)
    base_to_cur = {b: c for c, b in matched.items()}

    nodes: list[dict[str, Any]] = []
    counts = {k: 0 for k in ("gone", "detached", "new", "attached", "changed", "same")}

    def put(node: dict[str, Any], status: str, reasons: list[str], **more: Any) -> None:
        out = _strip_times(node)
        out.setdefault("extra", {})["change"] = {"status": status, "reasons": reasons, **more}
        nodes.append(out)
        if is_device(node):
            counts[status] += 1

    for cid, c in cur.devices.items():
        bid = matched.get(cid)
        if bid is None:
            reasons = ["New since the baseline"]
            joined = sorted(v for k, v in cur.attachments(cid).items() if not k.startswith("ap:"))
            if joined:
                reasons.append(f"Joined {_list(joined)}")
            status = "attached" if joined else "new"
            # A new access point using a name the baseline heard from other access points.
            if is_ap(c):
                for ssid in c.get("ssids") or []:
                    known = base.ssid_aps.get(ssid, set()) - {cid}
                    if known:
                        status = "changed"
                        reasons.append(
                            f"Possible rogue access point: broadcasts {ssid}, which the baseline heard only from "
                            f"{_list(sorted(_label(base.nodes[k]) for k in known))}"
                        )
            put(c, status, reasons)
            continue
        b = base.devices[bid]
        reasons = []
        if bid != cid:
            if cid in rotations:
                reasons.append(
                    f"MAC changed from {node_mac(b) or bid} to {node_mac(c) or cid} (randomized). "
                    f"Likely the same device: {_list(rotations[cid])}"
                )
            else:
                reasons.append(f"Same device as {_label(b)} in the baseline")
        status, att_reasons = _attachment_changes(base.attachments(bid), cur.attachments(cid))
        reasons += att_reasons + _property_changes(b, c)
        if status == "same" and reasons and cid in rotations:
            status = "changed"
        elif status == "same" and any(not r.startswith("Same device as") for r in reasons):
            status = "changed"
        put(c, status, reasons, **({"previous_id": bid} if bid != cid else {}))

    for bid, b in base.devices.items():
        if bid in base_to_cur:
            continue
        reasons = ["Not seen in the later survey"]
        was_on = sorted(v for k, v in base.attachments(bid).items() if not k.startswith("ap:"))
        if was_on:
            reasons.append(f"Was on {_list(was_on)}")
        put(b, "gone", reasons)

    # Subnets and VLANs: union, marked new or gone when only one survey has them.
    for nid, net in cur.nodes.items():
        if not is_device(net):
            put(net, "same" if nid in base.nodes else "new", [] if nid in base.nodes else [f"New {_Side._net_name(net)}"])
    for nid, net in base.nodes.items():
        if not is_device(net) and nid not in cur.nodes:
            put(net, "gone", [f"{_Side._net_name(net).capitalize()} no longer seen"])
    kept = {n["id"] for n in nodes}
    for net in nodes:
        members = (net.get("extra") or {}).get("members")
        if isinstance(members, list):
            net["extra"]["members"] = [base_to_cur.get(m, m) for m in members if base_to_cur.get(m, m) in kept]

    # Links: a baseline link is redrawn between the devices it joins now.
    def key(link: dict[str, Any], remap: dict[str, str] | None = None) -> tuple[str, str, str]:
        a, b = link.get("source"), link.get("target")
        if remap:
            a, b = remap.get(a, a), remap.get(b, b)
        return (*sorted((str(a), str(b))), str(link.get("kind")))

    later_keys = {key(link): link for link in cur.links}
    base_keys = {key(link, base_to_cur): link for link in base.links}
    links = []
    link_counts = {"removed": 0, "added": 0, "same": 0}
    for k, link in later_keys.items():
        status = "same" if k in base_keys else "added"
        out = _strip_times(link)
        out.setdefault("extra", {})["change"] = {"status": status}
        links.append(out)
        link_counts[status] += 1
    for k, link in base_keys.items():
        if k in later_keys:
            continue
        out = _strip_times(link)
        out["source"] = base_to_cur.get(out["source"], out["source"])
        out["target"] = base_to_cur.get(out["target"], out["target"])
        if out["source"] not in kept or out["target"] not in kept:
            continue
        out["id"] = f"was:{out['id']}"
        out.setdefault("extra", {})["change"] = {"status": "removed"}
        links.append(out)
        link_counts["removed"] += 1

    meta = copy.deepcopy(cur.graph.get("meta") or {})
    for drop in ("time_start", "time_end", "time_window"):
        meta.pop(drop, None)
    meta["comparison"] = {
        "baseline": baseline_name,
        "later": later_name,
        "devices": counts,
        "links": link_counts,
    }
    meta["node_count"] = len(nodes)
    meta["link_count"] = len(links)
    return {"nodes": nodes, "links": links, "meta": meta}
