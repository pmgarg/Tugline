import unittest

from textstats import word_count


class TestWordCount(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(word_count("one two three"), 3)

    def test_empty(self):
        self.assertEqual(word_count(""), 0)


if __name__ == "__main__":
    unittest.main()
