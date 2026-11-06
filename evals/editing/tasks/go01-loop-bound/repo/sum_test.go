package calc

import "testing"

func TestSumTo(t *testing.T) {
	if SumTo(3) != 6 || SumTo(1) != 1 {
		t.Fatal(SumTo(3))
	}
}
