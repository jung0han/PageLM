#!/usr/bin/env python3
"""Contract tests for the PageLM Development Lane."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "compose.development.yaml"
PREFLIGHT = ROOT / "scripts" / "development-lane-preflight.sh"
SHARED_SERVICES = ("litellm-proxy", "authentik-server-1", "mailpit")


class DevelopmentLaneTests(unittest.TestCase):
    def test_compose_is_source_mounted_and_has_no_build_keys(self) -> None:
        text = COMPOSE.read_text(encoding="utf-8")
        compose = yaml.safe_load(text)
        self.assertNotRegex(text, r"(?m)^\s+build:")
        self.assertTrue(
            any(
                isinstance(mount, str) and mount.split(":", 1)[0] == "."
                for service in compose["services"].values()
                for mount in service.get("volumes", [])
            )
        )

    def test_compose_targets_shared_platform(self) -> None:
        text = COMPOSE.read_text(encoding="utf-8")
        for service in SHARED_SERVICES:
            self.assertIn(service, text)
        self.assertIn("milvus:19530", text)

    def test_preflight_names_unhealthy_service(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            docker_stub = Path(directory) / "docker"
            docker_stub.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env sh
                    case "$*" in
                      *"authentik-server-1") printf 'unhealthy\\n' ;;
                      *) printf 'healthy\\n' ;;
                    esac
                    """
                ),
                encoding="utf-8",
            )
            docker_stub.chmod(0o755)
            result = subprocess.run(
                [str(PREFLIGHT)],
                cwd=ROOT,
                env={**os.environ, "DEVELOPMENT_LANE_DOCKER_CMD": str(docker_stub)},
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("authentik-server-1", result.stderr)
        self.assertIn("unhealthy", result.stderr)

    def test_docker_config_has_no_build_when_available(self) -> None:
        if shutil.which("docker") is None:
            self.skipTest("docker unavailable")
        result = subprocess.run(
            ["docker", "compose", "-f", str(COMPOSE), "config"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if "Cannot connect to the Docker daemon" in result.stderr:
            self.skipTest(result.stderr.strip())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotRegex(result.stdout, r"(?m)^\s+build:")


if __name__ == "__main__":
    unittest.main()
