import json, sys
import yaml

d = yaml.safe_load(open("deploy.yaml"))["services"]
assert d["web"]["image"] == "shop/web:1.5" and d["worker"]["image"] == "shop/worker:1.5"
assert d["worker"]["environment"] == ["LOG_LEVEL=info", "QUEUE=orders"]
assert d["web"]["environment"] == ["LOG_LEVEL=info"] and d["web"]["ports"] == ["80:8080"]
print("ok")
