// deno-lint-ignore-file no-explicit-any
import { encodeHex } from "@std/encoding";
import { md5 as md } from "@takker/md5";

export function deleteUndefinedProperty(obj: any): void {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (obj[key] === undefined) {
        delete obj[key];
      }
    }
  }
}

export function md5(str: string): string {
  return encodeHex(md(str));
}

export function resolveUrl(url: string, baseURL?: string): string {
  if (!baseURL) return url;
  if (url.startsWith("http")) {
    return url;
  }
  if (!baseURL.endsWith("/")) {
    baseURL += "/";
  }
  if (url.startsWith("/")) {
    url = url.substring(1);
  }
  return baseURL + url;
}
