public class Tsv {
    /** Joins fields with tabs; backslashes become \\ and tabs become \t inside fields. */
    public static String join(String... fields) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < fields.length; i++) {
            if (i > 0) sb.append("\t");
            sb.append(fields[i].replace("\t", "\\t"));
        }
        return sb.toString();
    }
}
