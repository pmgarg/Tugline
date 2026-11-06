from inventory import Inventory

def test_remove_all_drops_item():
    inv = Inventory()
    inv.add("apple", 2)
    inv.remove("apple", 2)
    assert "apple" not in inv.items

def test_partial_remove():
    inv = Inventory()
    inv.add("pear", 3)
    inv.remove("pear", 1)
    assert inv.items == {"pear": 2}
