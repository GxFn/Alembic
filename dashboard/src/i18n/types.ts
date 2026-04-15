/**
 * i18n type definitions for Alembic Dashboard.
 *
 * Locale objects are strongly typed — every key in `zh` must also exist in `en`.
 * Use dot-notation with the `t()` helper: `t('sidebar.recipes')`.
 */

export type Locale = 'zh' | 'en';

/** Recursively flatten an object type into dot-notation string literal union. */
type FlattenKeys<T, Prefix extends string = ''> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: FlattenKeys<
        T[K],
        Prefix extends '' ? K : `${Prefix}.${K}`
      >;
    }[keyof T & string];

/** Import the zh locale as canonical shape reference. */
import type { zh } from './locales/zh';
export type LocaleMessages = typeof zh;
export type MessageKey = FlattenKeys<LocaleMessages>;
