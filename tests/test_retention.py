"""Video retention: expire videos after N hours, never touch pictures/scripts or anything in progress."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auth      # noqa: E402
import server    # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 10, 10, 12, 0, 0, tzinfo=timezone.utc)


def hours_ago(h):
    return (NOW - timedelta(hours=h)).isoformat()


class PurgeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.gen = tmp / "generations"
        self.gen.mkdir()
        auth.DB_PATH = tmp / "users.db"
        auth.init_db()
        for p in (mock.patch.object(server, "GENERATIONS", self.gen), mock.patch.object(server, "VIDEO_RETENTION_HOURS", 48.0),
                  mock.patch.object(server, "ACTIVE_GENS", set())):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def make(self, name, kind, age_h, **extra):
        d = self.gen / name
        d.mkdir()
        meta = {"id": name, "kind": kind, **extra}
        if age_h is not None:
            meta["createdAt"] = hours_ago(age_h)
        (d / "meta.json").write_text(json.dumps(meta))
        (d / "clip.mp4").write_bytes(b"video")
        return d

    def left(self):
        return {p.name for p in self.gen.iterdir()}

    def test_should_delete_expired_videos_and_keep_pictures_scripts_and_fresh_videos(self):
        self.make("old-clip", "clip", 72)
        self.make("old-story", "story", 50)
        self.make("old-story-c01", "clip", 50, storyId="old-story")
        self.make("old-stitch", "stitch", 100)
        self.make("old-image", "image", 5000)
        self.make("old-script", "script", 5000)
        self.make("fresh-clip", "clip", 10)
        removed = server.purge_expired_videos(NOW)
        self.assertEqual(set(removed), {"old-clip", "old-story", "old-story-c01", "old-stitch"})
        self.assertEqual(self.left(), {"old-image", "old-script", "fresh-clip"})

    def test_should_expire_strictly_after_the_window(self):
        self.make("exactly-48h", "clip", 48)
        self.make("just-over", "clip", 48.0003)                    # ~1 second past
        self.assertEqual(server.purge_expired_videos(NOW), ["just-over"])
        self.assertIn("exactly-48h", self.left())

    def test_should_skip_anything_it_cannot_prove_is_an_old_video(self):
        self.make("no-date", "clip", None)
        bad = self.make("bad-date", "clip", 1)
        (bad / "meta.json").write_text(json.dumps({"kind": "clip", "createdAt": "yesterday-ish"}))
        (self.gen / "no-meta").mkdir()
        (self.gen / "bad name!").mkdir()                             # not a valid id
        (self.gen / "stray-file.txt").write_text("x")
        self.make("unknown-kind", "mystery", 9999)
        self.assertEqual(server.purge_expired_videos(NOW), [])
        self.assertEqual(len(self.left()), 6)

    def test_should_treat_a_naive_timestamp_as_utc(self):
        d = self.make("naive", "clip", None)
        (d / "meta.json").write_text(json.dumps({"kind": "clip", "createdAt": (NOW - timedelta(hours=60)).replace(tzinfo=None).isoformat()}))
        self.assertEqual(server.purge_expired_videos(NOW), ["naive"])

    def test_should_not_follow_symlinks_out_of_the_generations_folder(self):
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        (outside / "meta.json").write_text(json.dumps({"kind": "clip", "createdAt": hours_ago(500)}))
        (outside / "precious.txt").write_text("keep me")
        (self.gen / "link-to-outside").symlink_to(outside, target_is_directory=True)
        self.assertEqual(server.purge_expired_videos(NOW), [])
        self.assertTrue((outside / "precious.txt").exists())

    def test_should_never_purge_a_generation_that_is_still_running(self):
        self.make("story-live", "story", 60)
        self.make("story-live-c01", "clip", 60)
        self.make("other-old", "clip", 60)
        with mock.patch.object(server, "ACTIVE_GENS", {"story-live"}):
            self.assertEqual(server.purge_expired_videos(NOW), ["other-old"])
        self.assertTrue({"story-live", "story-live-c01"} <= self.left())
        self.assertEqual(set(server.purge_expired_videos(NOW)), {"story-live", "story-live-c01"})    # once it has finished

    def test_should_do_nothing_when_retention_is_off_and_support_a_dry_run(self):
        self.make("old", "clip", 500)
        self.assertEqual(server.purge_expired_videos(NOW, hours=0), [])
        self.assertEqual(server.purge_expired_videos(NOW, dry_run=True), ["old"])
        self.assertIn("old", self.left())                          # dry run deleted nothing
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 0.0):
            self.assertEqual(server.purge_expired_videos(NOW), [])

    def test_should_release_ownership_and_survive_a_failed_delete(self):
        a, _ = auth.create_user("amy")
        for name in ("one-old", "two-old"):
            self.make(name, "clip", 100)
            auth.claim(name, a)
        real = shutil.rmtree

        def flaky(path, *args, **kwargs):
            if Path(path).name == "one-old":
                raise OSError("disk busy")
            return real(path, *args, **kwargs)
        with mock.patch.object(shutil, "rmtree", side_effect=flaky):
            self.assertEqual(server.purge_expired_videos(NOW), ["two-old"])
        self.assertIn("one-old", self.left())
        self.assertNotIn("two-old", auth.owner_map())                  # released
        self.assertIn("one-old", auth.owner_map())                     # still owned: it still exists

    def test_should_track_active_generations_even_when_the_job_crashes(self):
        seen = []

        def boom():
            seen.append(set(server.ACTIVE_GENS))
            raise RuntimeError("engine failed")
        with self.assertRaises(RuntimeError):
            server._tracked("gen-1", boom)()
        self.assertEqual(seen, [{"gen-1"}])
        self.assertEqual(server.ACTIVE_GENS, set())


class SettingsTests(unittest.TestCase):
    def test_should_parse_the_retention_setting_safely(self):
        for raw, want in ((None, 0.0), ("", 0.0), ("48", 48.0), ("0.5", 0.5), ("0", 0.0), ("-5", 0.0), ("abc", 0.0), ("nan", 0.0),
                          ("1e9", 24.0 * 365)):
            self.assertEqual(server.parse_retention_hours(raw), want, raw)

    def test_should_compute_the_expiry_time_for_videos_only(self):
        for kind in ("clip", "story", "stitch"):
            exp = server.video_expires_at({"kind": kind, "createdAt": hours_ago(10)}, 48)
            self.assertEqual(datetime.fromisoformat(exp), NOW - timedelta(hours=10) + timedelta(hours=48))
        for meta in ({"kind": "image", "createdAt": hours_ago(1)}, {"kind": "script", "createdAt": hours_ago(1)},
                     {"kind": "clip"}, {"kind": "clip", "createdAt": "nonsense"}):
            self.assertIsNone(server.video_expires_at(meta, 48))
        self.assertIsNone(server.video_expires_at({"kind": "clip", "createdAt": hours_ago(1)}, 0))

    def test_should_only_start_the_cleaner_when_retention_is_on(self):
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 0.0):
            self.assertIsNone(server.start_retention_thread())
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 48.0), mock.patch("threading.Thread") as thread:
            server.start_retention_thread()
        self.assertTrue(thread.call_args.kwargs["daemon"])
        thread.return_value.start.assert_called_once()

    def test_should_default_to_48_hours_in_the_container_and_blueprint_but_off_locally(self):
        self.assertIn("VIDEOGEN_VIDEO_RETENTION_HOURS=48", (ROOT / "Dockerfile").read_text())
        self.assertRegex((ROOT / "render.yaml").read_text(), r"key: VIDEOGEN_VIDEO_RETENTION_HOURS[^\n]*\n\s+value: \"48\"")
        self.assertEqual(server.parse_retention_hours(None), 0.0)       # nothing is deleted unless someone opts in


class RetentionHttpTests(LiveServerCase):
    def setUp(self):
        p = mock.patch.object(server, "VIDEO_RETENTION_HOURS", 48.0)
        p.start()
        self.addCleanup(p.stop)

    def _gen(self, name, kind, age_h):
        d = server.GENERATIONS / name
        d.mkdir(exist_ok=True)
        (d / "meta.json").write_text(json.dumps({"id": name, "kind": kind, "createdAt": datetime.now(timezone.utc).isoformat()
                                                 if age_h == 0 else (datetime.now(timezone.utc) - timedelta(hours=age_h)).isoformat()}))
        auth.claim(name, self.uid["alice"])

    def test_should_tell_the_page_when_each_video_expires_but_not_pictures(self):
        self._gen("ret-video", "clip", 10)
        self._gen("ret-image", "image", 10)
        entries = {e["id"]: e for e in json.loads(self.req("alice", "GET", "/api/list").body)}
        exp = datetime.fromisoformat(entries["ret-video"]["meta"]["expiresAt"])
        self.assertAlmostEqual((exp - datetime.now(timezone.utc)).total_seconds() / 3600, 38, delta=0.1)
        self.assertNotIn("expiresAt", entries["ret-image"]["meta"])

    def test_should_report_the_retention_window_to_the_page(self):
        self.assertEqual(json.loads(self.req("alice", "GET", "/api/me").body)["videoRetentionHours"], 48.0)
        self.assertIn('"videoRetentionHours": 48.0', self.req("alice", "GET", "/").body.decode())

    def test_should_not_add_expiry_info_when_retention_is_off(self):
        self._gen("ret-video2", "clip", 10)
        with mock.patch.object(server, "VIDEO_RETENTION_HOURS", 0.0):
            entries = {e["id"]: e for e in json.loads(self.req("alice", "GET", "/api/list").body)}
        self.assertNotIn("expiresAt", entries["ret-video2"]["meta"])


@unittest.skipUnless(shutil.which("node"), "node not installed")
class ExpiryLabelTests(unittest.TestCase):
    """vgExpiry / vgRetentionNote are browser code: run the real functions under node with a fixed clock."""
    def run_js(self, body):
        src = (ROOT / "ui" / "vg-core.jsx").read_text()
        fns = ""
        for name in ("vgExpiry", "vgRetentionNote"):
            start = src.index("function " + name)
            fns += src[start:src.index("\n}\n", start) + 3]
        script = "const NOW=Date.UTC(2026,9,10,12,0,0); Date.now=()=>NOW; global.window={VG_USER:{videoRetentionHours:48}};\n" + fns + body
        return json.loads(subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout)

    def test_should_label_time_left_in_friendly_units(self):
        got = self.run_js("""const at=h=>new Date(NOW+h*36e5).toISOString();
          console.log(JSON.stringify([null,'junk',at(-1),at(0.5),at(5),at(30),at(100)].map(vgExpiry)))""")
        self.assertEqual(got, [None, None, {"text": "Expiring now", "soon": True}, {"text": "Expires in 30 min", "soon": True},
                               {"text": "Expires in 5 h", "soon": True}, {"text": "Expires in 30 h", "soon": False},
                               {"text": "Expires in 4 days", "soon": False}])

    def test_should_describe_the_retention_window_or_say_nothing(self):
        got = self.run_js("""const out=[vgRetentionNote()];
          window.VG_USER.videoRetentionHours=0; out.push(vgRetentionNote());
          window.VG_USER.videoRetentionHours=24; out.push(vgRetentionNote());
          window.VG_USER.videoRetentionHours=72; out.push(vgRetentionNote());
          console.log(JSON.stringify(out))""")
        self.assertIn("48 hours", got[0])
        self.assertIn("Pictures stay", got[0])
        self.assertIsNone(got[1])
        self.assertIn("1 day", got[2])
        self.assertIn("3 days", got[3])


if __name__ == "__main__":
    unittest.main()
