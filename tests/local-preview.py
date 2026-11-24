import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("local_preview", Path("scripts/local_preview.py"))
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalPreviewTest(unittest.TestCase):
    def test_identity_uses_actual_build(self):
        with patch.object(local, "output", side_effect=["sha256:" + "a" * 64, "sha256:" + "b" * 64]):
            first = local.immutable_image("preview-api", "developer")
            second = local.immutable_image("preview-api", "developer")
        self.assertNotEqual(first, second)
        self.assertEqual(second[1], "preview-api:local-" + "b" * 64)

    def test_deploy_uses_one_build_profile_and_rendered_name(self):
        env = {"MINIKUBE_PROFILE": "team-local", "NAMESPACE": "sample", "RELEASE": "r" * 53,
               "IMAGE_REPOSITORY": "preview-api", "IMAGE_TAG": "developer", "PR_NUMBER": "01", "COMMIT_SHA": "123"}
        image_id = "sha256:" + "a" * 64
        tag = "local-" + "a" * 64
        name = "r" * 53 + "-preview-a"
        resource = {"items": [{"metadata": {"name": name, "uid": "one", "generation": 2}, "spec": {"template": {"spec": {
            "containers": [{"name": "preview-api", "image": "preview-api:" + tag}]}}}}]}
        outputs = [image_id, "kind: Namespace", "namespace/sample", json.dumps(resource), json.dumps(resource)]
        with patch.dict(os.environ, env), patch.object(local, "output", side_effect=outputs) as reads, \
                patch.object(local.subprocess, "run") as run:
            local.main("deploy")
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn(["docker", "tag", image_id, "preview-api:" + tag], commands)
        self.assertIn(["minikube", "-p", "team-local", "image", "load", "--daemon", "preview-api:" + tag], commands)
        install = next(call for call in run.call_args_list if call.args[0][0] == "helm")
        self.assertEqual(install.args[0][1:3], ["--kube-context", "team-local"])
        values = json.loads(install.kwargs["input"])
        self.assertEqual(values["image"]["tag"], tag)
        self.assertEqual(values["image"]["pullPolicy"], "Never")
        self.assertEqual(values["preview"], {"prNumber": "01", "commitSha": "123"})
        self.assertIn("deployment/" + name, commands[-1])
        self.assertEqual(commands[-1][1:3], ["--context", "team-local"])
        self.assertIn("app.kubernetes.io/instance=" + env["RELEASE"], ",".join(reads.call_args.args))
        resource["items"][0]["metadata"]["generation"] += 1
        outputs[-1] = json.dumps(resource)
        with patch.dict(os.environ, env), patch.object(local, "output", side_effect=outputs), \
                patch.object(local.subprocess, "run"), self.assertRaisesRegex(RuntimeError, "Deployment changed"):
            local.main("deploy")

    def test_smoke_rejects_wrong_payload_even_in_optimized_python(self):
        with patch.object(local, "output", return_value='{"status":"wrong"}'):
            with self.assertRaisesRegex(ValueError, "/health"):
                local.verify_http(18080, {"health": {"status": "ok"}})

    def test_failed_port_forward_cannot_accept_another_listener(self):
        process = Mock(stdout=io.StringIO("Unable to listen on port 18080\n"))
        with self.assertRaisesRegex(RuntimeError, "Unable to listen"):
            local.wait_forward(process, 18080)


if __name__ == "__main__":
    unittest.main()
