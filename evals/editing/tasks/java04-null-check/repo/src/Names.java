import java.util.List;

public class Names {
    /** Upper-case initials of the names; null or empty names are skipped. */
    public static String initials(List<String> names) {
        StringBuilder sb = new StringBuilder();
        for (String n : names) {
            sb.append(Character.toUpperCase(n.charAt(0)));
        }
        return sb.toString();
    }
}
