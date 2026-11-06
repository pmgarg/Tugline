import json, sys
import yaml

c = json.load(open("config/app.json"))
assert c["server"]["tls"] == {"enabled": True, "cert": "/etc/ssl/shop.pem"}
assert c["server"]["port"] == 8080 and c["features"] == ["cart", "search"]
print("ok")
