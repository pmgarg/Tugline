import json, sys
import yaml

e = yaml.safe_load(open("environments.yaml"))
assert e["production"] == {"retries": 5, "timeout": 30}, e
assert e["staging"] == {"retries": 5, "timeout": 20}, e
print("ok")
