// Copyright 2018-2021 the oak authors. All rights reserved. MIT license.
import { assert, assertEquals } from "../test_deps.ts";
import { deleteUndefinedProperty, jsonParse, resolveUrl } from "./utils.ts";

const { test } = Deno;

test({
  name: "jsonParse",
  fn() {
    assertEquals(jsonParse("a"), "a");
    assertEquals(jsonParse("1"), 1);
    assertEquals(jsonParse(true), true);
    assertEquals(jsonParse(false), false);
    assertEquals(jsonParse(1), 1);
    assertEquals(jsonParse({}), {});
    assertEquals(jsonParse([]), []);
    assertEquals(jsonParse(["a", "b"]), ["a", "b"]);
    assertEquals(jsonParse(`{"a":"b"}`), { a: "b" });
  },
});

test({
  name: "deleteUndefinedProperty",
  fn() {
    const obj = {
      a: "b",
      c: undefined,
      d: null,
      e: false,
      f: "",
    };
    deleteUndefinedProperty(obj);

    assert(obj.a === "b");
    assertEquals(obj, { a: "b", d: null, e: false, f: "" });
  },
});

test("resolve function", async (t) => {
  await t.step("should return the input URL if baseURL is not provided", () => {
    const url = "https://example.com";
    const resolvedURL = resolveUrl(url);
    assertEquals(resolvedURL, url);
  });

  await t.step("should return the input URL if it starts with 'http'", () => {
    const url = "http://example.com";
    const resolvedURL = resolveUrl(url, "https://baseurl.com");
    assertEquals(resolvedURL, url);
  });

  await t.step("should resolve the URL using the baseURL", () => {
    const url = "test";
    const baseURL = "https://baseurl.com";
    const resolvedURL = resolveUrl(url, baseURL);
    assertEquals(resolvedURL, baseURL + "/" + url);
  });

  await t.step("should replace double slashes in the resolved URL", () => {
    const url = "test";
    const baseURL = "https://baseurl.com/";
    const resolvedURL = resolveUrl(url, baseURL);
    assertEquals(resolvedURL, baseURL + url);
  });
});
