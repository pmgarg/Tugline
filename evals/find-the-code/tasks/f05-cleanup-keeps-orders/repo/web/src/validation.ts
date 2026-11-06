const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function checkSignupForm(f: { email: string; zip: string; country: string }): string[] {
  const errors: string[] = [];
  if (!EMAIL.test(f.email)) errors.push('Please enter a valid e-mail address.');
  if (f.country === 'DE' && !/^\d{5}$/.test(f.zip)) errors.push('German postcodes have five digits.');
  return errors;
}
