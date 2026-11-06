package calc

// Grade maps a score to a letter: 90+ A, 80+ B, 70+ C, else F.
func Grade(score int) string {
	switch {
	case score >= 90:
		return "A"
	case score >= 80:
		return "B"
	case score >= 70:
		return "C"
	default:
		return "F"
	}
}
