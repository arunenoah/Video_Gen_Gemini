"""Curated examples: the bundling tool, the server-side validation/serving, and the example that ships in the repo."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import bundle_example as tool   # noqa: E402
import server                    # noqa: E402
from harness import LiveServerCase   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def make_png(path, color, size=(1600, 900)):
    from PIL import Image
    Image.new("RGB", size, color).save(path)


def make_generation(root, name="story-1", scenes=2, prompts=None, **meta_extra):
    """A fake finished story: children with prompts, frames, assets (one duplicate), a video file, and private fields."""
    gen = root / name
    gen.mkdir(parents=True)
    kids = []
    for i in range(1, scenes + 1):
        kid = root / f"{name}-c{i:02d}"
        kid.mkdir()
        (kid / "meta.json").write_text(json.dumps({"kind": "clip", "storyId": name, "duration": 5,
                                                   "prompt": (prompts or {}).get(i, f"Scene {i}: a penguin waves.")}))
        kids.append(kid.name)
    (gen / "meta.json").write_text(json.dumps({"id": name, "kind": "story", "status": "complete", "sourceIds": kids,
                                               "tier": "seedance-mini", "resolution": "720p", "aspectRatio": "16:9", "duration": 5 * scenes,
                                               "cost": 9.99, "createdAt": "2026-10-01T00:00:00+00:00", "owner": "secret-user", **meta_extra}))
    (gen / "clip.mp4").write_bytes(b"not really a video")
    (gen / "frames").mkdir()
    for i in range(1, 4):
        make_png(gen / "frames" / f"f{i:02d}.png", (10 * i, 80, 160), (640, 360))
    make_png(gen / "ref01.png", (200, 30, 30))
    make_png(gen / "src01.png", (200, 30, 30))            # identical picture to ref01 -> merged
    make_png(gen / "src02.png", (30, 200, 30))
    return gen


class BundleToolTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.gens = self.tmp / "generations"
        self.gens.mkdir()
        self.out = self.tmp / "examples"

    def tearDown(self):
        self._tmp.cleanup()

    def bundle(self, gen, **kw):
        kw.setdefault("title", "Little Penguin")
        return tool.bundle(gen, self.out, kw.pop("slug", "little-penguin"), **kw)

    def test_should_build_a_sanitised_example_without_cost_owner_or_timestamps(self):
        dest = self.bundle(make_generation(self.gens), summary="A short story.")
        data = json.loads((dest / "example.json").read_text())
        text = (dest / "example.json").read_text()
        for private in ("cost", "9.99", "owner", "secret-user", "createdAt", "story-1"):
            self.assertNotIn(private, text, private)
        self.assertEqual([s["n"] for s in data["scenes"]], [1, 2])
        self.assertEqual(data["scenes"][0]["prompt"], "Scene 1: a penguin waves.")
        self.assertEqual((data["engine"], data["resolution"], data["duration"]), ("Seedance 2.0 Mini", "720p", 10))
        self.assertTrue((dest / "clip.mp4").is_file() and (dest / "poster.jpg").is_file())

    def test_should_downscale_pictures_and_merge_identical_ones(self):
        from PIL import Image
        dest = self.bundle(make_generation(self.gens))
        data = json.loads((dest / "example.json").read_text())
        self.assertEqual(len(data["assets"]), 2)                                   # ref01 + src01 identical -> one entry
        self.assertEqual(data["assets"][0]["label"], "Character look + Scene picture")
        for a in data["assets"]:
            with Image.open(dest / a["file"]) as im:
                self.assertLessEqual(max(im.size), 1024)
                self.assertEqual(im.format, "JPEG")
        self.assertEqual(sorted(p.name for p in dest.glob("asset*.jpg")), [a["file"] for a in data["assets"]])

    def test_should_refuse_unsafe_text_and_leave_nothing_behind(self):
        gen = make_generation(self.gens, prompts={2: "a story with gore and torture"})
        with self.assertRaises(tool.BundleError) as ctx:
            self.bundle(gen)
        self.assertIn("safety word list", str(ctx.exception))
        self.assertFalse((self.out / "little-penguin").exists())
        with self.assertRaises(tool.BundleError):
            self.bundle(make_generation(self.gens, name="story-2"), title="porn night")

    def test_should_refuse_things_that_are_not_finished_standalone_videos(self):
        partial = make_generation(self.gens, name="p1", status="partial")
        with self.assertRaises(tool.BundleError):
            self.bundle(partial)
        child = self.gens / "story-1-c01"
        make_generation(self.gens)                                                  # creates story-1 and its children
        (child / "clip.mp4").write_bytes(b"x")
        with self.assertRaises(tool.BundleError):
            self.bundle(child)                                                      # a clip that belongs to a story
        nomedia = make_generation(self.gens, name="nomedia")
        (nomedia / "clip.mp4").unlink()
        with self.assertRaises(tool.BundleError):
            self.bundle(nomedia)

    def test_should_validate_the_slug_and_not_overwrite_without_force(self):
        gen = make_generation(self.gens)
        for bad in ("Bad Slug", "../x", "a", "UPPER", "x" * 80):
            with self.assertRaises(tool.BundleError, msg=bad):
                self.bundle(gen, slug=bad)
        self.bundle(gen)
        with self.assertRaises(tool.BundleError):
            self.bundle(gen)
        self.bundle(gen, force=True, title="Renamed")
        self.assertEqual(json.loads((self.out / "little-penguin" / "example.json").read_text())["title"], "Renamed")

    def test_should_refuse_oversized_videos_and_clean_up(self):
        gen = make_generation(self.gens)
        with mock.patch.object(tool, "MAX_VIDEO_MB", 0):
            with self.assertRaises(tool.BundleError) as ctx:
                self.bundle(gen)
        self.assertIn("--shrink", str(ctx.exception))
        self.assertFalse((self.out / "little-penguin").exists())

    def test_should_not_publish_a_scene_that_has_no_prompt(self):
        gen = make_generation(self.gens, prompts={1: "   "})
        with self.assertRaises(tool.BundleError):
            self.bundle(gen)
        self.assertFalse((self.out / "little-penguin").exists())

    def test_should_fall_back_when_ffprobe_is_missing_and_classify_shapes_otherwise(self):
        with mock.patch.object(tool.shutil, "which", return_value=None):
            self.assertEqual(tool.real_aspect(Path("x.mp4"), "9:16"), "9:16")
        for dims, want in (("960,960", "1:1"), ("1280,720", "16:9"), ("720,1280", "9:16"), ("1000,900", "1:1")):
            with mock.patch.object(tool.shutil, "which", return_value="/usr/bin/ffprobe"), \
                 mock.patch.object(tool.subprocess, "run", return_value=mock.Mock(stdout=dims + "\n")):
                self.assertEqual(tool.real_aspect(Path("x.mp4")), want, dims)


class ExamplesServerTests(LiveServerCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ex = Path(self._tmp.name)
        p = mock.patch.object(server, "EXAMPLES_DIR", self.ex)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self._tmp.cleanup)

    def example(self, slug="good", **overrides):
        d = self.ex / slug
        d.mkdir()
        (d / "clip.mp4").write_bytes(b"VIDEO-BYTES")
        make_png(d / "poster.jpg", (1, 2, 3), (64, 36))
        make_png(d / "asset01.jpg", (9, 9, 9), (64, 64))
        data = {"title": "Good example", "summary": "Shows how.", "kind": "story", "engine": "Seedance", "resolution": "720p",
                "aspect": "16:9", "duration": 5, "video": "clip.mp4", "poster": "poster.jpg",
                "scenes": [{"n": 1, "duration": 5, "prompt": "A penguin waves."}],
                "assets": [{"file": "asset01.jpg", "role": "scene", "label": "Scene picture"}], **overrides}
        (d / "example.json").write_text(json.dumps(data))
        return d

    def list(self, who="alice"):
        return json.loads(self.req(who, "GET", "/api/examples").body)

    def test_should_require_sign_in(self):
        self.example()
        self.assertEqual(self._raw("GET", "/api/examples").status, 302)
        self.assertEqual(self._raw("GET", "/examples/good/clip.mp4").status, 302)

    def test_should_list_valid_examples_in_a_public_shape(self):
        self.example()
        [ex] = self.list()
        self.assertEqual((ex["id"], ex["title"], ex["sceneCount"], ex["videoUrl"], ex["posterUrl"]),
                         ("good", "Good example", 1, "/examples/good/clip.mp4", "/examples/good/poster.jpg"))
        self.assertEqual(ex["assets"], [{"url": "/examples/good/asset01.jpg", "role": "scene", "label": "Scene picture"}])
        for private in ("cost", "owner", "createdAt", "video", "poster"):
            self.assertNotIn(private, ex)
        self.assertEqual(self.list("bob"), self.list("admin"))                         # same for every user

    def test_should_skip_anything_broken_or_suspicious(self):
        self.example("good")
        bad = self.ex / "badjson"
        bad.mkdir()
        (bad / "example.json").write_text("{not json")
        (self.ex / "nofile").mkdir()
        self.example("novideo")
        (self.ex / "novideo" / "clip.mp4").unlink()
        self.example("noscenes", scenes=[])
        self.example("emptyprompt", scenes=[{"n": 1, "duration": 5, "prompt": "  "}])
        self.example("flagged", scenes=[{"n": 1, "duration": 5, "prompt": "show me porn"}])
        self.example("badtitle", title="")
        self.example("traversal-video", video="../clip.mp4")
        self.example("Upper-Case")
        real = self.example("real-target")
        (self.ex / "link-example").symlink_to(real, target_is_directory=True)
        self.assertEqual([e["id"] for e in self.list()], ["good", "real-target"])

    def test_should_drop_unsafe_assets_but_keep_the_example(self):
        self.example("assets", assets=[
            {"file": "asset01.jpg", "role": "scene", "label": "ok"},
            {"file": "../asset01.jpg", "role": "scene", "label": "traversal"},
            {"file": "missing.jpg", "role": "scene", "label": "missing"},
            {"file": "example.json", "role": "scene", "label": "json"},
            {"file": "asset01.jpg", "role": "hacker", "label": "bad role"},
            "not a dict"])
        [ex] = self.list()
        self.assertEqual([a["label"] for a in ex["assets"]], ["ok"])

    def test_should_truncate_huge_text_and_order_by_order_then_title(self):
        self.example("zeta", order=1, title="Zeta")
        self.example("alpha", order=2, title="Alpha")
        self.example("beta", order=2, title="Beta", summary="s" * 5000, scenes=[{"n": 1, "duration": 5, "prompt": "p" * 20000}])
        got = self.list()
        self.assertEqual([e["id"] for e in got], ["zeta", "alpha", "beta"])
        beta = got[2]
        self.assertEqual((len(beta["summary"]), len(beta["scenes"][0]["prompt"])), (400, 8000))

    def test_should_serve_only_media_files_of_valid_examples(self):
        self.example()
        ok = self.req("alice", "GET", "/examples/good/clip.mp4")
        self.assertEqual((ok.status, ok.body), (200, b"VIDEO-BYTES"))
        for path in ("/examples/good/poster.jpg", "/examples/good/asset01.jpg"):
            self.assertEqual(self.req("alice", "GET", path).status, 200, path)
        for path in ("/examples/good/example.json", "/examples/good/", "/examples/good", "/examples/", "/examples/nope/clip.mp4",
                     "/examples/Good/clip.mp4", "/examples/good/clip.mp4/x", "/examples/good/..%2Fclip.mp4", "/examples/../server.py",
                     "/examples/good/%2e%2e/%2e%2e/users.db", "/examples/good/clip.txt", "/examples//clip.mp4"):
            self.assertEqual(self.req("alice", "GET", path).status, 404, path)
        self.assertEqual(self.req("alice", "HEAD", "/examples/good/clip.mp4").status, 405)

    def test_should_not_follow_a_symlink_out_of_an_example(self):
        d = self.example()
        secret = self.ex.parent / "secret.mp4"
        secret.write_bytes(b"SECRET")
        (d / "evil.mp4").symlink_to(secret)
        self.assertEqual(self.req("alice", "GET", "/examples/good/evil.mp4").status, 404)
        secret.unlink()


class ShippedExampleTests(unittest.TestCase):
    """The samples that actually ship in the repo must be valid, small, and free of private data."""
    def test_should_ship_at_least_one_valid_example_with_every_file_present(self):
        examples = server.load_examples(ROOT / "examples")
        self.assertGreaterEqual(len(examples), 1)
        for ex in examples:
            folder = ROOT / "examples" / ex["id"]
            self.assertTrue((folder / "clip.mp4").is_file(), ex["id"])
            self.assertTrue(ex["scenes"] and all(s["prompt"] for s in ex["scenes"]))
            for a in ex["assets"]:
                self.assertTrue((ROOT / a["url"].lstrip("/")).is_file(), a["url"])

    def test_should_keep_the_bundled_examples_small_and_free_of_private_fields(self):
        total = 0
        for f in (ROOT / "examples").rglob("*"):
            if f.is_file():
                total += f.stat().st_size
                self.assertLess(f.stat().st_size, 30_000_000, f.name)
        self.assertLess(total, 60_000_000)
        for js in (ROOT / "examples").glob("*/example.json"):
            text = js.read_text()
            for private in ('"cost"', '"owner"', '"createdAt"', "generations/", "/Users/"):
                self.assertNotIn(private, text, f"{js.parent.name}: {private}")

    def test_should_be_picked_up_by_the_docker_image_and_not_by_video_retention(self):
        self.assertNotIn("examples", (ROOT / ".dockerignore").read_text().split())
        self.assertNotEqual(server.EXAMPLES_DIR.resolve(), server.GENERATIONS.resolve())
        self.assertNotIn(server.EXAMPLES_DIR.resolve(), server.GENERATIONS.resolve().parents)


@unittest.skipUnless(shutil.which("node"), "node not installed")
class ExampleScriptTests(unittest.TestCase):
    def test_should_turn_an_example_into_a_script_the_parser_understands(self):
        src = (ROOT / "ui" / "vg-core.jsx").read_text()
        start = src.index("function vgExampleScript")
        fn = src[start:src.index("\n}\n", start) + 3]
        ex = {"scenes": [{"n": 1, "prompt": "First prompt."}, {"n": 2, "prompt": "Second\nmulti-line prompt."}]}
        out = subprocess.run(["node", "-e", fn + f"\nconsole.log(JSON.stringify(vgExampleScript({json.dumps(ex)})))"],
                             capture_output=True, text=True, check=True).stdout
        script = json.loads(out)
        self.assertEqual(script, "Clip 1 — Scene 1\nFirst prompt.\n\nClip 2 — Scene 2\nSecond\nmulti-line prompt.")
        self.assertRegex(script.split("\n")[0], r"(?i)^\s*(clip|scene)\s*\d+\b")             # what vgParseScript's header regex needs


if __name__ == "__main__":
    unittest.main()
