package calc

import "strconv"

// ParseAll converts every string to an int and stops at the first error.
func ParseAll(xs []string) ([]int, error) {
	out := make([]int, 0, len(xs))
	for _, x := range xs {
		n, err := strconv.Atoi(x)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}
