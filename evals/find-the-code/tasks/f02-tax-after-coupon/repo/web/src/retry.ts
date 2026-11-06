/** Call `fn` again after 250 ms, 500 ms, 1 s … when it throws or returns a 5xx/429. */
export async function withBackoff(fn: () => Promise<Response>, attempts = 5): Promise<Response> {
  let wait = 250;
  for (let i = 0; ; i++) {
    try {
      const r = await fn();
      if (r.status < 500 && r.status !== 429) return r;
      if (i === attempts - 1) return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
    }
    await new Promise((ok) => setTimeout(ok, wait + Math.random() * 100));
    wait *= 2;
  }
}
