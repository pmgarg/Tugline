import json, sys
import yaml

u = json.load(open("data/users.json"))
assert [x["active"] for x in u] == [True, True, False, True, True], u
print("ok")
