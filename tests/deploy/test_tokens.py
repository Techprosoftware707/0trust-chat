"""Design-token generator tests (python3 -m unittest discover -s tests/deploy)."""
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "design" / "tools"))
import gen_tokens  # noqa: E402


class TestTokens(unittest.TestCase):
    def test_base_values_not_media_overrides(self):
        t = gen_tokens.collect()
        # prefers-reduced-motion sets durations to 0ms inside @media; the base values must win.
        self.assertEqual(t["durations"]["dur-fast"], 120)
        self.assertEqual(t["durations"]["dur-med"], 220)

    def test_themes_differ_and_use_brand_palette(self):
        t = gen_tokens.collect()
        light, dark = t["themes"]["light"], t["themes"]["dark"]
        self.assertNotEqual(light["bg"], dark["bg"])
        self.assertEqual(dark["bg"], t["palette"]["lm-midnight-925"])
        self.assertEqual(light["accent"], t["palette"]["lm-cyan-700"])

    def test_generated_files_are_current(self):
        self.assertEqual(gen_tokens.main.__name__, "main")
        sys_argv = sys.argv
        try:
            sys.argv = ["gen_tokens.py", "--check"]
            self.assertEqual(gen_tokens.main(), 0, "run python3 design/tools/gen_tokens.py")
        finally:
            sys.argv = sys_argv


if __name__ == "__main__":
    unittest.main()
