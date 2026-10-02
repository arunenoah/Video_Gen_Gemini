"""Deployment readiness: proxy-safe host/IP handling, health check, HEAD hardening, data folder, deploy files."""
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ark_video        # noqa: E402
import auth             # noqa: E402
import openrouter_video # noqa: E402
import server           # noqa: E402
import veo              # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class FakeHandler:
    """Just enough of a request handler for Handler._client_ip."""
    def __init__(self, peer="10.0.0.9", xff=None):
        self.client_address = (peer, 5555)
        self.headers = {"X-Forwarded-For": xff} if xff is not None else {}
    _client_ip = server.Handler._client_ip


class HostAndClientIpTests(unittest.TestCase):
    def test_should_accept_public_hosts_with_and_without_port_but_nothing_else(self):
        hosts = server.build_allowed_hosts(10000, ["app.example.com"])
        for ok in ("app.example.com", "app.example.com:10000", "127.0.0.1:10000", "localhost:10000"):
            self.assertIn(ok, hosts)
        for bad in ("evil.example", "app.example.com.evil.example", "example.com", "127.0.0.1", ""):
            self.assertNotIn(bad, hosts)

    def test_should_use_the_tcp_peer_unless_a_proxy_is_trusted(self):
        with mock.patch.object(server, "TRUST_PROXY", False):
            self.assertEqual(FakeHandler(xff="1.2.3.4")._client_ip(), "10.0.0.9")

    def test_should_take_the_address_the_proxy_saw_not_what_the_client_claims(self):
        with mock.patch.object(server, "TRUST_PROXY", True), mock.patch.object(server, "PROXY_HOPS", 1):
            # a client forging X-Forwarded-For only adds entries on the LEFT; the proxy appends the real address on the right
            self.assertEqual(FakeHandler(xff="6.6.6.6, 203.0.113.7")._client_ip(), "203.0.113.7")
            self.assertEqual(FakeHandler(xff="203.0.113.7")._client_ip(), "203.0.113.7")
        with mock.patch.object(server, "TRUST_PROXY", True), mock.patch.object(server, "PROXY_HOPS", 2):
            self.assertEqual(FakeHandler(xff="6.6.6.6, 203.0.113.7, 198.51.100.1")._client_ip(), "203.0.113.7")

    def test_should_fall_back_to_the_peer_on_missing_or_malformed_forwarded_headers(self):
        with mock.patch.object(server, "TRUST_PROXY", True), mock.patch.object(server, "PROXY_HOPS", 1):
            for xff in (None, "", "not-an-ip", "<script>", "1.2.3.4.5", ","):
                self.assertEqual(FakeHandler(xff=xff)._client_ip(), "10.0.0.9", repr(xff))
        with mock.patch.object(server, "TRUST_PROXY", True), mock.patch.object(server, "PROXY_HOPS", 3):
            self.assertEqual(FakeHandler(xff="203.0.113.7")._client_ip(), "10.0.0.9")     # fewer hops than expected


class DeployHttpTests(LiveServerCase):
    def test_should_answer_the_health_check_without_login_or_a_valid_host(self):
        for host in (None, "unknown.example"):
            r = self._raw("GET", "/healthz", host=host)
            self.assertEqual((r.status, r.body), (200, b"ok"))

    def test_should_not_answer_head_requests_for_any_file(self):
        for path in ("/users.db", "/server.py", "/config.json", "/ui/logo.png", "/ui/login-hero-v2.jpg", "/login", "/"):
            self.assertEqual(self._raw("HEAD", path).status, 405, path)                    # anonymous
            self.assertEqual(self.req("alice", "HEAD", path).status, 405, path)            # signed in

    def test_should_serve_generations_from_the_relocated_data_folder(self):
        self.assertEqual(self.req("alice", "GET", "/generations/alice-gen/meta.json").status, 200)
        self.assertTrue(str(server.GENERATIONS).startswith(str(server.GENERATIONS.parent)))
        for evil in ("/generations/../users.db", "/generations/%2e%2e/%2e%2e/etc/passwd", "/generations/alice-gen/../../users.db"):
            self.assertIn(self.req("alice", "GET", evil).status, (400, 404), evil)


class UnreadableHomeTests(unittest.TestCase):
    """Regression: in the container the app user's HOME was /root (unreadable) → PermissionError crashed startup."""

    LOADERS = (("veo", lambda: veo.load_api_key(), "GEMINI_API_KEY"),
               ("anthropic", lambda: server.load_anthropic_key(), "ANTHROPIC_API_KEY"),
               ("openrouter", lambda: openrouter_video.load_api_key(), "OPENROUTER_API_KEY"),
               ("ark", lambda: ark_video.load_api_key(), "ARK_API_KEY"))

    def _no_keys(self):
        env = {k: "" for k in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ARK_API_KEY")}
        return mock.patch.dict(os.environ, env), mock.patch.object(veo, "config_key", return_value="")

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores file permissions")
    def test_should_treat_an_unreadable_home_as_no_key_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            locked = Path(tmp) / "locked"
            locked.mkdir()
            locked.chmod(0o000)
            try:
                env, cfg = self._no_keys()
                with env, cfg, mock.patch("pathlib.Path.home", return_value=locked):
                    self.assertEqual(veo.home_key_file(".gemini_api_key"), "")
                    for name, load, _ in self.LOADERS:
                        with self.assertRaises(RuntimeError, msg=name):        # "No … key", never PermissionError
                            load()
            finally:
                locked.chmod(0o700)

    def test_should_survive_a_missing_home_and_still_prefer_the_environment(self):
        env, cfg = self._no_keys()
        with env, cfg, mock.patch("pathlib.Path.home", side_effect=RuntimeError("no home")):
            self.assertEqual(veo.home_key_file(".x"), "")
            with self.assertRaises(RuntimeError):
                veo.load_api_key()
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "from-env"}), mock.patch("pathlib.Path.home", side_effect=RuntimeError):
            self.assertEqual(veo.load_api_key(), "from-env")

    def test_should_read_a_key_file_from_a_normal_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / ".gemini_api_key").write_text("  file-key \n")
            with mock.patch("pathlib.Path.home", return_value=Path(tmp)):
                self.assertEqual(veo.home_key_file(".gemini_api_key"), "file-key")

    def test_should_give_the_container_user_its_own_home(self):
        self.assertRegex((ROOT / "Dockerfile").read_text(), r"useradd .*--create-home --home-dir /home/app")
        self.assertIn("HOME=/home/app", (ROOT / "deploy" / "entrypoint.sh").read_text())


class DeployFilesTests(unittest.TestCase):
    def test_should_default_the_data_folder_to_the_project_for_local_use(self):
        self.assertEqual(auth.DATA_DIR, ROOT)                 # unless VIDEOGEN_DATA_DIR is set

    def test_should_pin_dependencies_and_install_ffmpeg_in_the_image(self):
        req = (ROOT / "requirements.txt").read_text()
        for pkg in ("google-genai", "Pillow", "segno"):
            self.assertRegex(req, rf"(?m)^{pkg}==\d")
        docker = (ROOT / "Dockerfile").read_text()
        self.assertIn("ffmpeg", docker)
        self.assertIn("deploy/entrypoint.sh", docker)
        self.assertNotRegex(docker, r"(?m)^\s*COPY\s+config\.json")

    def test_should_keep_secrets_and_user_data_out_of_images_and_the_blueprint(self):
        ignore = (ROOT / ".dockerignore").read_text().split()
        for must in ("config.json", "users.db", "generations", ".git", "ConnectID-Certificates", "server.log"):
            self.assertIn(must, ignore)
        blueprint = (ROOT / "render.yaml").read_text()
        for key in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ARK_API_KEY", "VIDEOGEN_PUBLIC_HOST"):
            self.assertRegex(blueprint, rf"key: {key}[^\n]*\n\s+sync: false")                    # asked for in the dashboard
        self.assertIsNone(re.search(r"sk-[A-Za-z0-9_-]{16,}|AQ\.[A-Za-z0-9_-]{20,}|ark-[0-9a-f-]{16,}", blueprint))
        self.assertIn("autoDeploy: false", blueprint)
        self.assertIn("numInstances: 1", blueprint)
        self.assertIn("healthCheckPath: /healthz", blueprint)
        self.assertRegex(blueprint, r"mountPath: /var/data")

    def test_should_run_the_app_as_a_non_root_user_after_fixing_disk_ownership(self):
        script = (ROOT / "deploy" / "entrypoint.sh").read_text()
        self.assertIn("setpriv --reuid=10001", script)
        self.assertIn("chown", script)
        self.assertTrue((ROOT / "deploy" / "entrypoint.sh").stat().st_mode & 0o111)        # executable


if __name__ == "__main__":
    unittest.main()
