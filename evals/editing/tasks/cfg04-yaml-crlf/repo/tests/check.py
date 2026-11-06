import json, sys
import yaml

s = yaml.safe_load(open("settings.yaml"))
assert s["http"]["timeout"] == 60 and s["db"]["timeout"] == 30, s
print("ok")
