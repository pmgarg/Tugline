export interface User {
  name: string;
  age: number;
}

/** Youngest first; equal ages sorted by name. */
export function byAgeThenName(users: User[]): User[] {
  return [...users].sort((a, b) => {
    if (a.age !== b.age) return a.age - b.age;
    return a.name.localeCompare(b.name);
  });
}
