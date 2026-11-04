import sys, unittest
sys.path.insert(0, "src")
from app import add

class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 2), 4)

unittest.main()
