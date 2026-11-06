package calc

import "testing"

func TestPath(t *testing.T) {
	if got := Path("bob"); got != `D:\Data\bob\notes.txt` {
		t.Fatal(got)
	}
}
