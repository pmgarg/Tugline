package calc

import "testing"

func TestGrade(t *testing.T) {
	for s, w := range map[int]string{95: "A", 80: "B", 70: "C", 69: "F"} {
		if Grade(s) != w {
			t.Fatal(s, Grade(s))
		}
	}
}
