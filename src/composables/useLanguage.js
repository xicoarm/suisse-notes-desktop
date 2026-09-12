import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

const languages = [
  { label: 'English', short: 'EN', value: 'en' },
  { label: 'Deutsch', short: 'DE', value: 'de' },
  { label: 'Fran\u00e7ais', short: 'FR', value: 'fr' },
  { label: 'Italiano', short: 'IT', value: 'it' }
];

export function useLanguage() {
  const { locale } = useI18n();

  // The i18n boot file already resolved saved choice → device language → 'de'.
  const currentLang = ref(localStorage.getItem('lang') || locale.value || 'de');

  const currentLangShort = computed(() => {
    const lang = languages.find(l => l.value === currentLang.value);
    return lang ? lang.short : String(currentLang.value || 'de').toUpperCase();
  });

  const setLanguage = (lang) => {
    currentLang.value = lang;
    locale.value = lang;
    localStorage.setItem('lang', lang);
  };

  const initLanguage = () => {
    const savedLang = localStorage.getItem('lang');
    if (savedLang) {
      locale.value = savedLang;
      currentLang.value = savedLang;
    }
  };

  return {
    languages,
    currentLang,
    currentLangShort,
    setLanguage,
    initLanguage
  };
}
