package calc

import "strings"

const header = `C:\Users\{{user}}\notes.txt`

// Path fills in the user name.
func Path(user string) string {
	return strings.Replace(header, "{{user}}", user, 1)
}
