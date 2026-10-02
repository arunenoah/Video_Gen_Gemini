"""Shared live-server harness for HTTP tests: temp DB + generations dir, real Handler on an ephemeral port,
mocked paid engines/AI, and signed-in cookies for admin/alice/bob/carl."""
import http.client
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import auth      # noqa: E402
import safety    # noqa: E402
import server    # noqa: E402

PW = "correct-horse-battery"


def _now_step() -> int:
    return int(time.time() // auth.TOTP_PERIOD)


class LiveServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls._tmp.name)
        auth.DB_PATH = tmp / "users.db"
        auth._FAILS.clear()
        auth.init_db()
        auth.ENGINE_IDS[:] = (list(server.ENGINES) + list(server.openrouter_chat.CHAT_MODELS)
                              + list(server.openrouter_chat.IMAGE_MODELS))
        cls._orig_gen = server.GENERATIONS
        server.GENERATIONS = tmp / "generations"
        server.GENERATIONS.mkdir()
        # the stdlib file handler resolves from ROOT; point /generations/ at the temp dir instead
        cls._orig_tp = server.Handler.translate_path
        server.Handler.translate_path = lambda self, path: (
            str(server.GENERATIONS / path.split("?")[0][len("/generations/"):])
            if path.startswith("/generations/") else cls._orig_tp(self, path))
        safety.configure(lambda t: '{"verdict":"allow","category":"other"}')   # no real AI calls in tests
        safety.configure_image(lambda raw, mime: '{"verdict":"allow","category":"other"}')
        cls._orig_run = server.run_generation, server.check_engine_key
        server.run_generation = lambda *a, **k: None          # never call a paid engine from tests
        server.check_engine_key = lambda tier: None
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        server.ALLOWED_HOSTS.add(f"127.0.0.1:{cls.port}")
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

        cls.cookies, cls.uid = {}, {}
        for name, role in (("admin", "admin"), ("alice", "user"), ("bob", "user"), ("carl", "user")):
            uid, token = auth.create_user(name, role)
            secret = auth.enrollment_user(token)["totp_secret"]
            auth.complete_enrollment(token, PW, auth.totp_code(secret, _now_step()), "7.7.7.7")
            cls.uid[name] = uid
            cls.cookies[name] = cls._login(name, secret)
        cls._make_gen("alice-gen", owner="alice")
        cls._make_gen("alice-gen-c01", owner=None)                   # clip: inherits via prefix
        cls._make_gen("legacy-gen", owner=None)
        server.JOBS["job-alice"] = {"status": "running", "owner": cls.uid["alice"]}

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        safety.configure(server._classify_with_haiku)
        safety.configure_image(server._classify_image_with_haiku)
        server.run_generation, server.check_engine_key = cls._orig_run
        server.Handler.translate_path = cls._orig_tp
        server.GENERATIONS = cls._orig_gen
        server.JOBS.pop("job-alice", None)
        cls._tmp.cleanup()

    @classmethod
    def _make_gen(cls, gen_id, owner):
        d = server.GENERATIONS / gen_id
        d.mkdir()
        (d / "meta.json").write_text(json.dumps({"id": gen_id, "createdAt": "2026-01-01"}))
        (d / "clip.mp4").write_bytes(b"x")
        if owner:
            auth.claim(gen_id, cls.uid[owner])

    @classmethod
    def _login(cls, username, secret):
        r = cls._raw("POST", "/login", urlencode({"username": username, "password": PW}), None, form=True)
        pending = r.getheader("Set-Cookie").split(";")[0]
        code = auth.totp_code(secret, _now_step() + 1)
        r = cls._raw("POST", "/login/2fa", urlencode({"code": code}), pending, form=True)
        return [c.split(";")[0] for c in r.msg.get_all("Set-Cookie") if c.startswith("vg_session=")][0]

    @classmethod
    def _raw(cls, method, path, body=None, cookie=None, form=False, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        headers = {"Host": host or f"127.0.0.1:{cls.port}"}
        if cookie:
            headers["Cookie"] = cookie
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        conn.request(method, path, body, headers)
        resp = conn.getresponse()
        resp.body = resp.read()
        conn.close()
        return resp

    def req(self, who, method, path, body=None, form=False):
        return self._raw(method, path, body, self.cookies.get(who), form)


    def _admin_post(self, path, **fields):
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        return self.req("admin", "POST", path, urlencode({**fields, "csrf": csrf}), True)

    def _gen_body(self, tier="lite"):
        return json.dumps({"prompt": "a cat", "tier": tier, "resolution": "720p", "duration": 8, "aspect": "16:9"})

    def _admin_post_multi(self, path, engines, **fields):
        """Admin POST with repeated `engine` checkbox fields."""
        csrf = auth.get_session(self.cookies["admin"].split("=")[1])["csrf"]
        body = urlencode({**fields, "csrf": csrf}) + "".join("&" + urlencode({"engine": e}) for e in engines)
        return self.req("admin", "POST", path, body, True)
