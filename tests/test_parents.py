"""Parents page: the AI Explorers section exists and states the privacy facts."""
import re
import unittest
from pathlib import Path

PAGE = Path(__file__).resolve().parent.parent / "ui" / "parents.html"


class ParentsAiExplorersTests(unittest.TestCase):
    def section(self):
        m = re.search(r'<section id="ai-explorers">(.*?)</section>', PAGE.read_text(), re.S)
        self.assertIsNotNone(m, "AI Explorers section missing")
        return m.group(1)

    def test_should_have_ai_explorers_section_when_page_loaded(self):
        self.assertIn("AI Explorers", self.section())

    def test_should_say_progress_stays_on_device_when_describing_privacy(self):
        self.assertIn("stays on the device", self.section())

    def test_should_mention_grown_up_okay_when_linking_code_org(self):
        s = self.section()
        self.assertIn("Code.org", s)
        self.assertIn("grown-up taps a confirmation", s)


if __name__ == "__main__":
    unittest.main()
