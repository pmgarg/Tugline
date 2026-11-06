def parse_line(line):
    """'apple, 3' -> ('apple', 3)"""
    name, qty = line.split(",")
    return name.strip(), qty.strip()
