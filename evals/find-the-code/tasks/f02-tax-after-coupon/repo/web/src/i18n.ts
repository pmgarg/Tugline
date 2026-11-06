const MESSAGES: Record<string, Record<string, string>> = {
  en: { checkout: 'Checkout', empty: 'Your basket is empty' },
  de: { checkout: 'Zur Kasse', empty: 'Ihr Warenkorb ist leer' },
  ar: { checkout: 'الدفع', empty: 'سلتك فارغة' },
};

export function t(key: string, locale = 'en'): string {
  return MESSAGES[locale]?.[key] ?? MESSAGES.en[key] ?? key;
}

export const isRightToLeft = (locale: string) => locale === 'ar';
