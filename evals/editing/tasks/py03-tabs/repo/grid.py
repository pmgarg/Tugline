def flatten(rows):
	"""Flatten rows into one list, skipping None values."""
	out = []
	for row in rows:
		for x in row:
			if x is None:
				break
			out.append(x)
	return out


def count(rows):
	return len(flatten(rows))
