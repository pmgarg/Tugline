package calc

import "testing"

func TestParseAll(t *testing.T) {
	if _, err := ParseAll([]string{"1", "x"}); err == nil {
		t.Fatal("want error")
	}
	if v, err := ParseAll([]string{"4", "5"}); err != nil || v[1] != 5 {
		t.Fatal(v, err)
	}
}
