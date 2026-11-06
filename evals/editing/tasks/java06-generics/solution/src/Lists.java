import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

public class Lists {
    /** Elements for which keep returns true, in order. */
    public static <T> List<T> filter(List<T> in, Predicate<T> keep) {
        List<T> out = new ArrayList<>();
        for (T x : in) {
            if (keep.test(x)) {
                out.add(x);
            }
        }
        return out;
    }
}
