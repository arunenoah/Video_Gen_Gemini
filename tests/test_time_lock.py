"""Daily screen-time lock must cover every activity pane, not only chat / pictures / videos.

Regression: a child with 60 min allowed used 76 min because Block Builder (client-only play, no API calls)
kept running after the allowance was spent. Only the Library stays open when time is up.
"""
import re
import unittest
from pathlib import Path

UI = Path(__file__).resolve().parent.parent / "ui"
CHAT = (UI / "vg-views-chat.jsx").read_text()

# every sidebar activity mode except the Library (look-only) and Users (admins are never limited)
LOCKED_MODES = ("chat", "image", "video", "lab", "aix", "blocks", "examples")


class TimeLockCoverageTests(unittest.TestCase):
    def test_should_show_the_locked_pane_for_every_activity_mode_when_time_is_up(self):
        m = re.search(r"\{locked && ([^\n]*?) && <LockedPane", CHAT)
        self.assertIsNotNone(m, "LockedPane must be rendered when locked")
        cond = m.group(1)
        for mode in LOCKED_MODES:
            self.assertIn(mode, cond, f"time-up screen must cover mode '{mode}'")
        self.assertNotIn("'library'", cond, "Library stays open so kids can look at what they made")

    def test_should_not_mount_play_panes_while_locked(self):
        for pane in ("<PromptLabPane", "<AIExplorersPane key={viewKey}", "<AIExplorersPane key={'blocks' + viewKey}", "<ExamplesPane"):
            line = next((l for l in CHAT.splitlines() if pane in l), None)
            self.assertIsNotNone(line, pane)
            self.assertIn("!locked", line, f"{pane} must unmount (stopping the game) when time is up")

    def test_should_keep_the_library_available_when_locked(self):
        line = next(l for l in CHAT.splitlines() if "<LibraryPane" in l)
        self.assertNotIn("!locked", line)


if __name__ == "__main__":
    unittest.main()
