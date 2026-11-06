import json, sys
import yaml

p = json.load(open("package.json"))
assert p["version"] == "1.3.0"
assert p["scripts"] == {"build": "tsc -p .", "test": "node --test", "lint": "eslint ."}, p["scripts"]
assert p["devDependencies"] == {"typescript": "^5.9.3"}
print("ok")
