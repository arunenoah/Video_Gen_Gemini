"""Game-spec validation: the security boundary between the AI's JSON and the browser game engine.

Pure (no I/O) and total: every function swallows any input type, including None, huge nesting, NaN and giant
strings, and never raises. The model's output is only ever *data*: unknown keys are dropped, numbers are clamped,
colours must be #rrggbb, enums come from fixed sets, every string is stripped / length-capped / local-safety-checked.
Mirrored client-side by AIXEngine.clientValidate (defence in depth).
"""

import json
import math
import re

import safety

MAX_JSON_CHARS = 8000
TEMPLATES = ("catcher", "runner", "maze", "shooter", "quiz", "blocks")
SHAPES = ("circle", "square", "triangle", "star", "heart")
GOAL_KINDS = ("score", "survive", "reach")
THEMES = ("space", "forest", "sea", "city", "candy")
TERRAINS = ("meadow", "desert", "snow", "island", "candy")   # Block Builder 3D world look
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f-\x9f  ​-‏‪-‮⁦-⁩]")
_UNSAFE = re.compile(r"[<>]|javascript\s*:|data\s*:", re.I)      # markup / script-ish text never reaches the canvas
_DEFAULT_COLORS = ("#ff7a59", "#4cc9f0", "#ffd166", "#06d6a0", "#ef476f", "#9b5de5")   # fixed fallback palette
_DEFAULT_BG = "#1b2a49"
_ROW_RE = re.compile(r"^[0-9]{8}$")
MATERIALS = ".gdswlbaytcpj"                         # Block Builder alphabet: "." air, then cartoon-only materials
BUILD_SIZE, BUILD_MAX_LAYERS = 12, 6
_BUILD_ROW = re.compile(r"^[.gdswlbaytcpj]{12}$")


class _Bad(Exception):
    """Internal: one validation error message (collected, never escapes this module)."""


def extract_json(text) -> dict | None:
    """First balanced {...} object in `text` that parses as JSON → dict, else None. Refuses > MAX_JSON_CHARS.
    json.loads only (no eval); never raises."""
    try:
        if not isinstance(text, str) or len(text) > MAX_JSON_CHARS:
            return None
        start, tries = text.find("{"), 0
        while start != -1 and tries < 5:
            tries += 1
            depth, in_str, esc = 0, False, False
            for i in range(start, len(text)):          # brace matching that ignores braces inside strings
                ch = text[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                elif ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            obj = json.loads(text[start:i + 1])
                        except (ValueError, RecursionError):
                            break
                        return obj if isinstance(obj, dict) else None
            start = text.find("{", start + 1)
        return None
    except Exception:
        return None


def _str(v, cap: int, label: str, required: bool = True) -> str | None:
    """Clean one string: control chars out, stripped, capped, then must pass the local safety filter."""
    if v is None and not required:
        return None
    if not isinstance(v, str):
        raise _Bad(f"{label} must be text")
    s = _CTRL.sub("", v[:cap * 4]).strip()[:cap].strip()     # cut first so a 10k string is never scanned whole
    if not s:
        if required:
            raise _Bad(f"{label} is empty")
        return None
    if _UNSAFE.search(s):
        raise _Bad(f"{label} contains characters that are not allowed")
    if safety.local_check(s):
        raise _Bad(f"{label} is not kid-friendly")
    return s


def _int(v, lo: int, hi: int, label: str) -> int:
    """Number → int clamped to lo..hi. bool / NaN / inf / non-numbers are errors."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise _Bad(f"{label} must be a number")
    if isinstance(v, float):
        if not math.isfinite(v):
            raise _Bad(f"{label} must be a finite number")
        v = int(v)
    return max(lo, min(hi, v))


def _enum(v, allowed: tuple, label: str) -> str:
    s = v.strip().lower() if isinstance(v, str) else None
    if s not in allowed:
        raise _Bad(f"{label} must be one of {', '.join(allowed)}")
    return s


def _color(v, fallback: str) -> str:
    return v if isinstance(v, str) and _HEX.match(v) else fallback


def _sprite(v) -> dict | None:
    """Exact 8x8 sprite or None (an invalid sprite is dropped; the shape is drawn instead)."""
    if not isinstance(v, dict):
        return None
    pal, rows = v.get("palette"), v.get("rows")
    if not (isinstance(pal, list) and 1 <= len(pal) <= 6 and all(isinstance(c, str) and _HEX.match(c) for c in pal)):
        return None
    if not (isinstance(rows, list) and len(rows) == 8 and all(isinstance(r, str) and _ROW_RE.match(r) for r in rows)):
        return None
    if any(int(ch) >= len(pal) for r in rows for ch in r):
        return None
    return {"palette": [c.lower() for c in pal], "rows": list(rows)}


def _actor(v, label: str, slot: int) -> dict:
    if not isinstance(v, dict):
        raise _Bad(f"{label} must be an object")
    out = {"shape": _enum(v.get("shape"), SHAPES, f"{label}.shape"),
           "color": _color(v.get("color"), _DEFAULT_COLORS[slot % len(_DEFAULT_COLORS)]),
           "name": _str(v.get("name"), 20, f"{label}.name")}
    sprite = _sprite(v.get("sprite"))
    if sprite:
        out["sprite"] = sprite
    return out


def _obj(v, label: str) -> dict:
    if not isinstance(v, dict):
        raise _Bad(f"{label} must be an object")
    return v


def _quiz(v) -> dict:
    qs = _obj(v, "quiz").get("questions")
    if not isinstance(qs, list) or not qs:
        raise _Bad("quiz needs at least one question")
    out = []
    for n, q in enumerate(qs[:6]):
        q = _obj(q, f"question {n + 1}")
        opts = q.get("options")
        if not isinstance(opts, list) or len(opts) != 3:
            raise _Bad(f"question {n + 1} needs exactly 3 options")
        ans = q.get("answer")
        if isinstance(ans, bool) or not isinstance(ans, int) or not 0 <= ans <= 2:
            raise _Bad(f"question {n + 1} answer must be 0, 1 or 2")      # never clamp: that would change the right answer
        out.append({"q": _str(q.get("q"), 80, f"question {n + 1}"),
                    "options": [_str(o, 30, f"question {n + 1} option") for o in opts], "answer": ans})
    return {"questions": out}


def _build(v) -> dict:
    """Block Builder grid: 1..6 layers (bottom first) of exactly 12 rows of exactly 12 chars from MATERIALS.
    Needs >= 1 block and >= 1 walkable column (top is not water). Strict: never clamped or repaired."""
    layers = _obj(v, "build").get("layers")
    if not isinstance(layers, list) or not 1 <= len(layers) <= BUILD_MAX_LAYERS:
        raise _Bad(f"build needs 1 to {BUILD_MAX_LAYERS} layers")
    out = []
    for n, layer in enumerate(layers):
        if not isinstance(layer, list) or len(layer) != BUILD_SIZE:
            raise _Bad(f"build layer {n + 1} needs exactly {BUILD_SIZE} rows")
        if not all(isinstance(r, str) and _BUILD_ROW.fullmatch(r) for r in layer):    # fullmatch: `$` would allow a trailing newline
            raise _Bad(f"build layer {n + 1} rows need exactly {BUILD_SIZE} known block letters")
        out.append(list(layer))
    tops = {}                                            # (x, y) → highest non-air char of that column
    for layer in out:                                    # bottom first, so later layers overwrite
        for y, row in enumerate(layer):
            for x, ch in enumerate(row):
                if ch != ".":
                    tops[(x, y)] = ch
    if not tops:
        raise _Bad("build has no blocks")
    if all(ch == "a" for ch in tops.values()):
        raise _Bad("build needs some ground to walk on")
    return {"layers": out}


def validate_spec(obj) -> tuple[dict | None, list[str]]:
    """Strict allow-list validation → (clean spec, []) or (None, errors). Never raises."""
    errors: list[str] = []

    def take(fn, *a):
        try:
            return fn(*a)
        except _Bad as e:
            errors.append(str(e))
            return None

    try:
        if not isinstance(obj, dict):
            return None, ["spec must be a JSON object"]
        template = take(_enum, obj.get("template"), TEMPLATES, "template")
        goal, world, rules, texts, items = (take(_obj, obj.get(k), k) for k in ("goal", "world", "rules", "texts", "items"))
        clean = {"v": 1, "template": template, "title": take(_str, obj.get("title"), 40, "title")}
        clean["hero"] = take(_actor, obj.get("hero"), "hero", 0)
        if goal is not None:
            clean["goal"] = {"kind": take(_enum, goal.get("kind"), GOAL_KINDS, "goal.kind"),
                             "target": take(_int, goal.get("target"), 3, 50, "goal.target")}
        if items is not None:
            clean["items"] = {"good": take(_actor, items.get("good"), "items.good", 1),
                              "bad": take(_actor, items.get("bad"), "items.bad", 4)}
        if world is not None:
            clean["world"] = {"bg": _color(world.get("bg"), _DEFAULT_BG),
                              "theme": take(_enum, world.get("theme"), THEMES, "world.theme")}
            if template == "blocks":                     # terrain + seed exist iff blocks; defaulted when missing, strict when present
                clean["world"]["terrain"] = (take(_enum, world["terrain"], TERRAINS, "world.terrain")
                                             if "terrain" in world else "meadow")
                clean["world"]["seed"] = take(_int, world["seed"], 0, 999999, "world.seed") if "seed" in world else 1
        if rules is not None:
            clean["rules"] = {k: take(_int, rules.get(k), 1, 5, f"rules.{k}") for k in ("speed", "lives", "spawnRate")}
        if texts is not None:
            clean["texts"] = {k: take(_str, texts.get(k), 80, f"texts.{k}") for k in ("start", "win", "lose")}
        if template == "quiz":                           # quiz block exists iff the template is quiz
            clean["quiz"] = take(_quiz, obj.get("quiz"))
        if template == "blocks":                         # build grid exists iff the template is blocks
            clean["build"] = take(_build, obj.get("build"))
        ask = take(_str, obj.get("ask"), 80, "ask", False)
        if ask:
            clean["ask"] = ask
        ideas = obj.get("nextIdeas")
        if isinstance(ideas, list) and len(ideas) >= 2:
            got = [take(_str, i, 30, "nextIdeas") for i in ideas[:3]]
            if all(got):
                clean["nextIdeas"] = got
        if errors or any(v is None for v in _flat(clean)):
            return None, errors or ["spec is incomplete"]
        return clean, []
    except Exception:                                    # RecursionError, MemoryError… — fail closed
        return None, ["spec could not be read"]


def _flat(d: dict):
    """Required values that came back None (an error was already recorded for each)."""
    for v in d.values():
        if isinstance(v, dict):
            yield from _flat(v)
        else:
            yield v


def validate_ideas(obj) -> tuple[list[str] | None, list[str]]:
    """{'ideas': [3 strings]} (or a bare list) → (3 clean strings <= 80 chars, []) or (None, errors). Never raises."""
    try:
        items = obj.get("ideas") if isinstance(obj, dict) else obj
        if not isinstance(items, list) or len(items) < 3:
            return None, ["need three ideas"]
        out, errors = [], []
        for i in items[:3]:
            try:
                out.append(_str(i, 80, "idea"))
            except _Bad as e:
                errors.append(str(e))
        return (None, errors) if errors else (out, [])
    except Exception:
        return None, ["ideas could not be read"]


def spec_texts(spec: dict) -> str:
    """Every kid-visible string of a clean spec joined for one output safety check."""
    parts = [spec.get("title", ""), spec.get("ask", ""), *spec.get("nextIdeas", []),
             spec["hero"]["name"], spec["items"]["good"]["name"], spec["items"]["bad"]["name"], *spec["texts"].values()]
    for q in (spec.get("quiz") or {}).get("questions", []):
        parts += [q["q"], *q["options"]]
    return "\n".join(p for p in parts if p)
