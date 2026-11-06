public class Check {
    public static void main(String[] args) {
        if (!(Tsv.join("a\\b", "c\td").equals("a\\\\b\tc\\td"))) throw new AssertionError("escaping");
        if (!(Tsv.join("x", "y").equals("x\ty"))) throw new AssertionError("plain");
        System.out.println("ok");
    }
}
