package calc

// SumTo returns 1 + 2 + ... + n.
func SumTo(n int) int {
	total := 0
	for i := 1; i <= n; i++ {
		total += i
	}
	return total
}
