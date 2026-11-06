class Inventory:
    def __init__(self):
        self.items = {}

    def add(self, name, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.items[name] = self.items.get(name, 0) + qty

    def remove(self, name, qty):
        have = self.items.get(name, 0)
        if qty > have:
            raise ValueError("not enough %s" % name)
        self.items[name] = have - qty
        if self.items[name] < 0:
            del self.items[name]

    def total(self):
        return sum(self.items.values())
