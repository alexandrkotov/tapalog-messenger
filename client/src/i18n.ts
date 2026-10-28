const strings = {
  en: {
    title: "Tapalog Messenger",
    checking: "Connecting to the server…",
    online: "Server is online",
    offline: "No connection to the server. Your messages will wait until it is back.",
    version: "Server version",
  },
  ru: {
    title: "Tapalog Messenger",
    checking: "Подключаемся к серверу…",
    online: "Сервер на связи",
    offline: "Нет связи с сервером. Сообщения подождут, пока он не вернётся.",
    version: "Версия сервера",
  },
  uk: {
    title: "Tapalog Messenger",
    checking: "Підключаємося до сервера…",
    online: "Сервер на зв'язку",
    offline: "Немає зв'язку з сервером. Повідомлення зачекають, доки він не повернеться.",
    version: "Версія сервера",
  },
} as const;

export type Lang = keyof typeof strings;
export type Strings = (typeof strings)[Lang];

/** First of the browser's preferred languages that we have, by primary subtag (ru-RU → ru); English otherwise. */
export function pickLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base && base in strings) return base as Lang;
  }
  return "en";
}

export function t(lang: Lang): Strings {
  return strings[lang];
}
