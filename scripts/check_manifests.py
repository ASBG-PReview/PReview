import sys
from pathlib import Path

import yaml

namespaces = set()
for filename in sys.argv[1:]:
    documents = [doc for doc in yaml.safe_load_all(Path(filename).read_text()) if doc]
    namespace = next(doc["metadata"]["name"] for doc in documents if doc["kind"] == "Namespace")
    assert namespace not in namespaces, "Preview namespaces must be distinct"
    namespaces.add(namespace)
    for doc in documents:
        if doc["kind"] != "Namespace":
            assert doc["metadata"]["namespace"] == namespace
    pod = next(doc for doc in documents if doc["kind"] == "Deployment")["spec"]["template"]
    assert pod["spec"]["automountServiceAccountToken"] is False
    assert pod["spec"]["securityContext"]["runAsNonRoot"] is True
    container = pod["spec"]["containers"][0]
    assert container["readinessProbe"]["httpGet"]["path"] == "/health"
    assert container["securityContext"]["readOnlyRootFilesystem"] is True
    assert {"requests", "limits"} <= container["resources"].keys()
    policy = next(doc for doc in documents if doc["kind"] == "NetworkPolicy")
    assert policy["spec"]["egress"] == []
    assert any(doc["kind"] == "ResourceQuota" for doc in documents)
print(f"Verified {len(namespaces)} isolated preview manifests")
