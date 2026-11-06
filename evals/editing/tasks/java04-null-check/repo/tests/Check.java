public class Check {
    public static void main(String[] args) {
        java.util.List<String> xs = new java.util.ArrayList<>(java.util.Arrays.asList("ann", null, "", "bo"));
        if (!(Names.initials(xs).equals("AB"))) throw new AssertionError("skip null/empty");
        System.out.println("ok");
    }
}
