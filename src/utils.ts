// deno-lint-ignore-file no-explicit-any
import { encode, Hash } from "../deps.ts";

export function jsonParse(str: any) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

export function deleteUndefinedProperty(obj: any) {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (obj[key] === undefined) {
        delete obj[key];
      }
    }
  }
}

export function md5(str: string) {
  return new Hash("md5").digest(encode(str)).hex();
}
