from __future__ import annotations

from netseer.compare import compare_graphs, is_randomized
from netseer.ingest import ingest_files
from netseer.samples import files_for_sample


def _sample(sample_id: str) -> dict:
    return ingest_files(files_for_sample(sample_id)).to_dict()


def _by_mac(result: dict) -> dict[str, dict]:
    return {n["id"].removeprefix("mac:"): n["extra"]["change"] for n in result["nodes"]}


def _node(nid: str, kind: str = "host", **fields) -> dict:
    return {"id": nid, "kind": kind, "label": fields.pop("label", nid.split(":", 1)[1]), **fields}


def _link(a: str, b: str, kind: str, label: str = "") -> dict:
    return {"id": f"{kind}:{a}|{b}", "source": a, "target": b, "kind": kind, "label": label}


def test_randomized_macs():
    assert is_randomized("da:a1:19:3c:5e:71") and is_randomized("6e:4f:02:9b:d3:28") and is_randomized("02:00:00:00:00:01")
    assert not is_randomized("f0:18:98:60:00:01") and not is_randomized(None) and not is_randomized("zz:00")


def test_branch_samples_show_every_kind_of_change():
    result = compare_graphs(_sample("branch-baseline"), _sample("branch-later"), baseline_name="Monday", later_name="A week later")
    ch = _by_mac(result)
    assert ch["00:17:c8:60:00:05"]["status"] == "gone"  # the printer
    assert "Was on Wi-Fi Branch-Staff" in ch["00:17:c8:60:00:05"]["reasons"]
    assert ch["00:40:8c:60:00:04"] == {"status": "detached", "reasons": ["Left Wi-Fi Branch-Cams"]}  # yard camera
    assert ch["dc:a9:04:60:00:06"]["status"] == "attached"  # new tablet on staff Wi-Fi
    assert "Joined Wi-Fi Branch-Staff" in ch["dc:a9:04:60:00:06"]["reasons"]
    laptop = ch["f0:18:98:60:00:01"]
    assert laptop["status"] == "changed" and laptop["reasons"] == ["Moved from Wi-Fi Branch-Staff to Wi-Fi Branch-Guest"]
    phone = ch["6e:4f:02:9b:d3:28"]  # rotated its randomized MAC
    assert phone["status"] == "changed" and phone["previous_id"] == "mac:da:a1:19:3c:5e:71"
    assert "MAC changed from da:a1:19:3c:5e:71" in phone["reasons"][0] and "Pixel-7-Hotspot" in phone["reasons"][0]
    assert "mac:da:a1:19:3c:5e:71" not in {n["id"] for n in result["nodes"]}  # one device, not two
    rogue = ch["02:0c:29:66:6e:01"]
    assert rogue["status"] == "changed" and any("Possible rogue access point" in r and "00:3a:9a:b0:00:01" in r for r in rogue["reasons"])
    for unchanged in ("a4:c3:f0:60:00:02", "00:40:8c:60:00:03", "00:3a:9a:b0:00:01", "00:3a:9a:b0:00:02", "00:3a:9a:b0:00:03"):
        assert ch[unchanged] == {"status": "same", "reasons": []}, unchanged
    comp = result["meta"]["comparison"]
    assert comp["baseline"] == "Monday" and comp["later"] == "A week later"
    assert comp["devices"] == {"gone": 1, "detached": 1, "new": 0, "attached": 1, "changed": 3, "same": 5}
    # Links: the laptop's staff link and the printer's and yard camera's links are drawn as removed.
    links = {(frozenset((l["source"], l["target"])), l["extra"]["change"]["status"]) for l in result["links"]}
    assert (frozenset(("mac:f0:18:98:60:00:01", "mac:00:3a:9a:b0:00:01")), "removed") in links
    assert (frozenset(("mac:f0:18:98:60:00:01", "mac:00:3a:9a:b0:00:02")), "added") in links
    # The phone's association keeps its place: redrawn on its new MAC, unchanged.
    assert (frozenset(("mac:6e:4f:02:9b:d3:28", "mac:00:3a:9a:b0:00:02")), "same") in links
    assert comp["links"] == {"removed": 3, "added": 2, "same": 3}
    assert all(not n["seen"] for n in result["nodes"]) and all(not l["seen"] for l in result["links"])


def test_identical_surveys_have_no_changes():
    graph = _sample("branch-baseline")
    result = compare_graphs(graph, graph)
    assert {n["extra"]["change"]["status"] for n in result["nodes"]} == {"same"}
    assert {l["extra"]["change"]["status"] for l in result["links"]} == {"same"}


def test_subnets_addresses_and_access_point_settings():
    base = {
        "nodes": [
            _node("ip:10.0.0.5", ips=["10.0.0.5"], inferred_type="Host"),
            _node("mac:00:11:22:33:44:55", ips=["10.0.1.9"], inferred_type="Host", services=["ssh tcp/22"]),
            _node("mac:00:aa:bb:00:00:01", kind="ap", ssids=["Corp"], encryption=["WPA2"], channels=[6]),
            _node("subnet:10.0.0.0/24", kind="subnet", label="10.0.0.0/24"),
            _node("subnet:10.0.1.0/24", kind="subnet", label="10.0.1.0/24"),
        ],
        "links": [_link("mac:00:11:22:33:44:55", "subnet:10.0.1.0/24", "subnet")],
    }
    later = {
        "nodes": [
            # Seen by MAC this time, at the same address: the same device.
            _node("mac:00:11:22:33:00:05", ips=["10.0.0.5"], macs=["00:11:22:33:00:05"], inferred_type="Host"),
            _node("mac:00:11:22:33:44:55", ips=["10.0.0.9"], inferred_type="Server", services=["ssh tcp/22", "http tcp/80"]),
            _node("mac:00:aa:bb:00:00:01", kind="ap", ssids=["Corp"], encryption=["Open"], channels=[11]),
            _node("subnet:10.0.0.0/24", kind="subnet", label="10.0.0.0/24"),
            _node("subnet:10.0.1.0/24", kind="subnet", label="10.0.1.0/24"),
        ],
        "links": [_link("mac:00:11:22:33:44:55", "subnet:10.0.0.0/24", "subnet")],
    }
    result = compare_graphs(base, later)
    ch = {n["id"]: n["extra"]["change"] for n in result["nodes"]}
    assert ch["mac:00:11:22:33:00:05"] == {"status": "same", "reasons": ["Same device as 10.0.0.5 in the baseline"], "previous_id": "ip:10.0.0.5"}
    moved = ch["mac:00:11:22:33:44:55"]
    assert moved["status"] == "changed"
    assert moved["reasons"] == [
        "Moved from subnet 10.0.1.0/24 to subnet 10.0.0.0/24",
        "Address changed from 10.0.1.9 to 10.0.0.9",
        "Type changed from Host to Server",
        "New services: http tcp/80",
    ]
    ap = ch["mac:00:aa:bb:00:00:01"]
    assert ap["status"] == "changed"
    assert ap["reasons"] == ["Security changed from WPA2 to Open", "Channel changed from 6 to 11"]


def test_unrelated_random_macs_are_not_paired():
    base = {"nodes": [_node("mac:da:00:00:00:00:01", kind="client", medium="wireless", ssids=["Home"])], "links": []}
    later = {"nodes": [_node("mac:6e:00:00:00:00:02", kind="client", medium="wireless", ssids=["Cafe"])], "links": []}
    ch = {n["id"]: n["extra"]["change"]["status"] for n in compare_graphs(base, later)["nodes"]}
    assert ch == {"mac:6e:00:00:00:00:02": "new", "mac:da:00:00:00:00:01": "gone"}


def test_compare_api():
    from fastapi.testclient import TestClient

    import netseer.web as webmod

    client = TestClient(webmod.app)
    body = {"baseline": _sample("branch-baseline"), "later": _sample("branch-later"), "baseline_name": "Mon", "later_name": "Next Mon"}
    res = client.post("/api/compare", json=body)
    assert res.status_code == 200
    assert res.json()["meta"]["comparison"]["devices"]["changed"] == 3
    assert client.post("/api/compare", json={"baseline": {}}).status_code == 400
    assert client.post("/api/compare", json={"baseline": {"nodes": "x"}, "later": {}}).status_code == 400


def test_a_network_everyone_probes_is_not_evidence():
    # 60 phones probing the same hotspot name, all rotating MACs: nothing to pair them by.
    def phones(prefix: str) -> dict:
        return {"nodes": [_node(f"mac:{prefix}:00:00:00:00:{i:02x}", kind="client", medium="wireless", ssids=["xfinitywifi"]) for i in range(60)], "links": []}

    statuses = {n["extra"]["change"]["status"] for n in compare_graphs(phones("da"), phones("6e"))["nodes"]}
    assert statuses == {"gone", "new"}
